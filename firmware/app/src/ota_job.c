#include "ota_job.h"

#include <ctype.h>
#include <math.h>
#include <string.h>

#include <cJSON.h>

#define JSON_MAX_DEPTH 6
#define URL_SCHEME     "https://"

/*
 * The JSON parser recurses once per nesting level. Reject deeply nested input before
 * it reaches the parser, so that a hostile message cannot exhaust the stack.
 */
static bool depth_within_limit(const char *json, size_t len)
{
	int depth = 0;
	bool in_string = false;
	bool escaped = false;

	for (size_t i = 0; i < len; i++) {
		char c = json[i];

		if (in_string) {
			if (escaped) {
				escaped = false;
			} else if (c == '\\') {
				escaped = true;
			} else if (c == '"') {
				in_string = false;
			}
			continue;
		}

		if (c == '"') {
			in_string = true;
		} else if (c == '{' || c == '[') {
			if (++depth > JSON_MAX_DEPTH) {
				return false;
			}
		} else if (c == '}' || c == ']') {
			depth--;
		}
	}

	return true;
}

static const char *string_member(const cJSON *object, const char *name)
{
	const cJSON *item = cJSON_GetObjectItemCaseSensitive(object, name);

	return cJSON_IsString(item) ? item->valuestring : NULL;
}

/* A JSON number that is a whole value between min and max. */
static bool integer_member(const cJSON *object, const char *name, double min, double max,
			   uint32_t *out)
{
	const cJSON *item = cJSON_GetObjectItemCaseSensitive(object, name);
	double value;

	if (!cJSON_IsNumber(item)) {
		return false;
	}

	value = item->valuedouble;
	if (!(value >= min && value <= max) || floor(value) != value) {
		return false;
	}

	*out = (uint32_t)value;
	return true;
}

static bool copy_job_id(const char *text, char *out)
{
	size_t length;

	if (text == NULL) {
		return false;
	}

	length = strlen(text);
	if (length == 0 || length > OTA_JOB_ID_MAX) {
		return false;
	}

	/* The characters AWS IoT allows in a job ID. The ID is later put into an MQTT
	 * topic, so nothing else may get through.
	 */
	for (size_t i = 0; i < length; i++) {
		char c = text[i];

		if (!isalnum((unsigned char)c) && c != '-' && c != '_') {
			return false;
		}
	}

	memcpy(out, text, length + 1);
	return true;
}

static int hex_value(char c)
{
	if (c >= '0' && c <= '9') {
		return c - '0';
	}

	if (c >= 'a' && c <= 'f') {
		return c - 'a' + 10;
	}

	return -1;
}

static bool parse_sha256(const char *text, uint8_t *out)
{
	if (text == NULL || strlen(text) != 2 * OTA_SHA256_SIZE) {
		return false;
	}

	for (size_t i = 0; i < OTA_SHA256_SIZE; i++) {
		int high = hex_value(text[2 * i]);
		int low = hex_value(text[2 * i + 1]);

		if (high < 0 || low < 0) {
			return false;
		}

		out[i] = (uint8_t)((high << 4) | low);
	}

	return true;
}

/*
 * Accept a URL only if it starts with the provisioned prefix, then split it into the
 * two parts the download client takes. The prefix ends inside the path, so the host
 * is fixed by it and cannot be changed by the rest of the URL.
 */
static enum ota_job_result split_url(const char *url, const char *allowed_prefix,
				     struct ota_job *job)
{
	size_t url_length;
	size_t prefix_length;
	const char *host_start;
	const char *host_end;
	const char *file;
	size_t host_length;
	size_t file_length;

	if (url == NULL || allowed_prefix == NULL) {
		return OTA_JOB_BAD_DOCUMENT;
	}

	url_length = strlen(url);
	prefix_length = strlen(allowed_prefix);

	if (url_length > OTA_JOB_HOST_MAX + 1 + OTA_JOB_FILE_MAX) {
		return OTA_JOB_BAD_DOCUMENT;
	}

	for (size_t i = 0; i < url_length; i++) {
		if (!isgraph((unsigned char)url[i])) {
			return OTA_JOB_BAD_DOCUMENT;
		}
	}

	if (prefix_length <= strlen(URL_SCHEME) ||
	    strncmp(allowed_prefix, URL_SCHEME, strlen(URL_SCHEME)) != 0 ||
	    strchr(allowed_prefix + strlen(URL_SCHEME), '/') == NULL) {
		/* Without a usable prefix nothing may be downloaded. */
		return OTA_JOB_URL_NOT_ALLOWED;
	}

	if (url_length <= prefix_length || strncmp(url, allowed_prefix, prefix_length) != 0) {
		return OTA_JOB_URL_NOT_ALLOWED;
	}

	host_start = url + strlen(URL_SCHEME);
	host_end = strchr(host_start, '/');
	host_length = (size_t)(host_end - host_start);
	file = host_end + 1;
	file_length = strlen(file);

	if (host_length == 0 || host_length > 255 || file_length == 0 ||
	    file_length > OTA_JOB_FILE_MAX) {
		return OTA_JOB_BAD_DOCUMENT;
	}

	for (size_t i = 0; i < host_length; i++) {
		char c = host_start[i];

		/* No port, no user information, no IPv6 literal. */
		if (!isalnum((unsigned char)c) && c != '.' && c != '-') {
			return OTA_JOB_BAD_DOCUMENT;
		}
	}

	/*
	 * The download client's URL parser treats a colon as a port separator and "//"
	 * as a scheme separator wherever they appear, and a fragment makes no sense in a
	 * request. Presigned URLs percent-encode all of these.
	 */
	if (strchr(file, ':') != NULL || strchr(file, '#') != NULL || strstr(file, "//") != NULL) {
		return OTA_JOB_BAD_DOCUMENT;
	}

	memcpy(job->host, url, strlen(URL_SCHEME) + host_length);
	job->host[strlen(URL_SCHEME) + host_length] = '\0';
	memcpy(job->file, file, file_length + 1);

	return OTA_JOB_OK;
}

static enum ota_job_result parse_document(const cJSON *document, const char *allowed_url_prefix,
					  struct ota_job *job)
{
	const cJSON *firmware;
	const char *operation;
	uint32_t document_version;
	enum ota_job_result result;

	if (!cJSON_IsObject(document)) {
		return OTA_JOB_BAD_DOCUMENT;
	}

	operation = string_member(document, "op");
	if (operation == NULL || strcmp(operation, "fw_update") != 0 ||
	    !integer_member(document, "v", 1, 1, &document_version)) {
		return OTA_JOB_UNSUPPORTED;
	}

	firmware = cJSON_GetObjectItemCaseSensitive(document, "fw");
	if (!cJSON_IsObject(firmware)) {
		return OTA_JOB_BAD_DOCUMENT;
	}

	if (fw_version_parse(string_member(firmware, "version"), &job->version) != 0 ||
	    !integer_member(firmware, "size", 1, UINT32_MAX, &job->size) ||
	    !parse_sha256(string_member(firmware, "sha256"), job->sha256)) {
		return OTA_JOB_BAD_DOCUMENT;
	}

	result = split_url(string_member(firmware, "url"), allowed_url_prefix, job);
	return result;
}

/*
 * The MQTT interface embeds the job document as an object. Other AWS IoT interfaces
 * deliver the same document as a string of JSON; accept that form too.
 */
static enum ota_job_result parse_execution_document(const cJSON *execution,
						    const char *allowed_url_prefix,
						    struct ota_job *job)
{
	const cJSON *document = cJSON_GetObjectItemCaseSensitive(execution, "jobDocument");
	enum ota_job_result result;
	cJSON *embedded;

	if (!cJSON_IsString(document)) {
		return parse_document(document, allowed_url_prefix, job);
	}

	if (!depth_within_limit(document->valuestring, strlen(document->valuestring))) {
		return OTA_JOB_BAD_DOCUMENT;
	}

	embedded = cJSON_Parse(document->valuestring);
	result = parse_document(embedded, allowed_url_prefix, job);
	cJSON_Delete(embedded);
	return result;
}

enum ota_job_result ota_job_parse(const char *json, size_t len, const char *allowed_url_prefix,
				  struct ota_job *job)
{
	enum ota_job_result result;
	const cJSON *execution;
	const char *status;
	cJSON *root;

	if (json == NULL || job == NULL) {
		return OTA_JOB_MALFORMED;
	}

	memset(job, 0, sizeof(*job));

	if (!depth_within_limit(json, len)) {
		return OTA_JOB_MALFORMED;
	}

	root = cJSON_ParseWithLength(json, len);
	if (!cJSON_IsObject(root)) {
		cJSON_Delete(root);
		return OTA_JOB_MALFORMED;
	}

	execution = cJSON_GetObjectItemCaseSensitive(root, "execution");
	if (execution == NULL) {
		cJSON_Delete(root);
		return OTA_JOB_NONE;
	}

	if (!cJSON_IsObject(execution) || !copy_job_id(string_member(execution, "jobId"), job->id)) {
		cJSON_Delete(root);
		memset(job, 0, sizeof(*job));
		return OTA_JOB_MALFORMED;
	}

	status = string_member(execution, "status");
	job->in_progress = (status != NULL) && strcmp(status, "IN_PROGRESS") == 0;

	result = parse_execution_document(execution, allowed_url_prefix, job);
	cJSON_Delete(root);

	if (result != OTA_JOB_OK) {
		/* Leave only what identifies the execution, so that the caller can refuse it. */
		char id[OTA_JOB_ID_MAX + 1];
		bool in_progress = job->in_progress;

		memcpy(id, job->id, sizeof(id));
		memset(job, 0, sizeof(*job));
		memcpy(job->id, id, sizeof(id));
		job->in_progress = in_progress;
	}

	return result;
}

enum ota_job_result ota_job_check(const struct ota_job *job, const struct fw_version *running,
				  size_t slot_size)
{
	/* Equal versions are refused too: re-sending an old job must not do anything. */
	if (fw_version_compare(&job->version, running) <= 0) {
		return OTA_JOB_NOT_NEWER;
	}

	if (job->size > slot_size) {
		return OTA_JOB_TOO_LARGE;
	}

	return OTA_JOB_OK;
}

const char *ota_job_result_reason(enum ota_job_result result)
{
	switch (result) {
	case OTA_JOB_OK:
		return "ok";
	case OTA_JOB_NONE:
		return "no_job";
	case OTA_JOB_UNSUPPORTED:
		return "unsupported";
	case OTA_JOB_URL_NOT_ALLOWED:
		return "url_not_allowed";
	case OTA_JOB_NOT_NEWER:
		return "not_newer";
	case OTA_JOB_TOO_LARGE:
		return "too_large";
	case OTA_JOB_MALFORMED:
	case OTA_JOB_BAD_DOCUMENT:
	default:
		return "bad_document";
	}
}
