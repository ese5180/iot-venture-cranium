/*
 * Host-side tests for job parsing and version handling.
 *
 * A job message is input from outside the device, so these tests concentrate on what
 * must be refused.
 */

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ota_job.h"
#include "version.h"

#define PREFIX "https://fw-bucket.s3.us-east-1.amazonaws.com/firmware/"
#define SHA    "99543f2f1a12346c1c755193ea21687f80b781da56bedaa5c0f1d2a3b4c5d6e7"
#define URL    PREFIX SHA ".bin?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=" \
	       "ASIAEXAMPLE%2F20261010%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=" \
	       "20261010T225344Z&X-Amz-Expires=600&X-Amz-SignedHeaders=host&X-Amz-Signature=abcdef"

static int failures;
static int checks;

#define CHECK(condition)                                                                     \
	do {                                                                                 \
		checks++;                                                                    \
		if (!(condition)) {                                                          \
			failures++;                                                          \
			printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);         \
		}                                                                            \
	} while (0)

static char message[8192];

/* Build a jobs reply around a job document given as JSON text. */
static const char *reply(const char *job_id, const char *status, const char *document)
{
	snprintf(message, sizeof(message),
		 "{\"clientToken\":\"x\",\"timestamp\":1760137000,\"execution\":{\"jobId\":\"%s\","
		 "\"status\":\"%s\",\"queuedAt\":1760136000,\"lastUpdatedAt\":1760136000,"
		 "\"versionNumber\":1,\"executionNumber\":1,\"jobDocument\":%s}}",
		 job_id, status, document);
	return message;
}

static char document[4096];

static const char *doc(const char *op, const char *v, const char *version, const char *size,
		       const char *sha, const char *url)
{
	snprintf(document, sizeof(document),
		 "{\"op\":\"%s\",\"v\":%s,\"fw\":{\"version\":\"%s\",\"size\":%s,"
		 "\"sha256\":\"%s\",\"url\":\"%s\"}}",
		 op, v, version, size, sha, url);
	return document;
}

static enum ota_job_result parse(const char *json, struct ota_job *job)
{
	return ota_job_parse(json, strlen(json), PREFIX, job);
}

static enum ota_job_result parse_doc(const char *document_json)
{
	struct ota_job job;

	return parse(reply("cranium-1-2-3-b4-20261010T225344Z-e707", "QUEUED", document_json), &job);
}

static void test_valid_job(void)
{
	struct ota_job job;
	const char *json = reply("cranium-1-2-3-b4-20261010T225344Z-e707", "QUEUED",
				 doc("fw_update", "1", "1.2.3+4", "768066", SHA, URL));

	CHECK(parse(json, &job) == OTA_JOB_OK);
	CHECK(strcmp(job.id, "cranium-1-2-3-b4-20261010T225344Z-e707") == 0);
	CHECK(!job.in_progress);
	CHECK(job.version.major == 1 && job.version.minor == 2 && job.version.revision == 3 &&
	      job.version.build == 4);
	CHECK(job.size == 768066);
	CHECK(job.sha256[0] == 0x99 && job.sha256[1] == 0x54 && job.sha256[31] == 0xe7);
	CHECK(strcmp(job.host, "https://fw-bucket.s3.us-east-1.amazonaws.com") == 0);
	CHECK(strncmp(job.file, "firmware/" SHA ".bin?X-Amz-Algorithm=", 9 + 64 + 21) == 0);
	CHECK(strstr(job.file, "X-Amz-Signature=abcdef") != NULL);

	json = reply("cranium-1-2-3-b4-20261010T225344Z-e707", "IN_PROGRESS",
		     doc("fw_update", "1", "1.2.3+4", "768066", SHA, URL));
	CHECK(parse(json, &job) == OTA_JOB_OK);
	CHECK(job.in_progress);
}

static void test_document_as_string(void)
{
	struct ota_job job;
	char quoted[4096];
	size_t used = 0;
	const char *plain = doc("fw_update", "1", "2.0.0+0", "1024", SHA, URL);

	quoted[used++] = '"';
	for (const char *c = plain; *c != '\0'; c++) {
		if (*c == '"' || *c == '\\') {
			quoted[used++] = '\\';
		}
		quoted[used++] = *c;
	}
	quoted[used++] = '"';
	quoted[used] = '\0';

	CHECK(parse(reply("job-1", "QUEUED", quoted), &job) == OTA_JOB_OK);
	CHECK(job.version.major == 2 && job.size == 1024);
	CHECK(parse(reply("job-1", "QUEUED", "\"not json\""), &job) == OTA_JOB_BAD_DOCUMENT);
}

static void test_no_job_and_malformed(void)
{
	struct ota_job job;
	char deep[256];
	size_t used = 0;

	CHECK(parse("{\"clientToken\":\"x\",\"timestamp\":1760137000}", &job) == OTA_JOB_NONE);
	CHECK(parse("", &job) == OTA_JOB_MALFORMED);
	CHECK(parse("[]", &job) == OTA_JOB_MALFORMED);
	CHECK(parse("{\"execution\":", &job) == OTA_JOB_MALFORMED);
	CHECK(parse("{\"execution\":7}", &job) == OTA_JOB_MALFORMED);
	CHECK(parse("{\"execution\":{\"status\":\"QUEUED\"}}", &job) == OTA_JOB_MALFORMED);
	CHECK(ota_job_parse(NULL, 0, PREFIX, &job) == OTA_JOB_MALFORMED);

	/* Job IDs end up in an MQTT topic: nothing but the characters AWS IoT allows. */
	CHECK(parse(reply("job/../x", "QUEUED", "{}"), &job) == OTA_JOB_MALFORMED);
	CHECK(parse(reply("job+1", "QUEUED", "{}"), &job) == OTA_JOB_MALFORMED);
	CHECK(parse(reply("job#", "QUEUED", "{}"), &job) == OTA_JOB_MALFORMED);
	CHECK(parse(reply("", "QUEUED", "{}"), &job) == OTA_JOB_MALFORMED);
	CHECK(parse(reply("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			  "QUEUED", "{}"),
		    &job) == OTA_JOB_MALFORMED);

	/* Nesting deep enough to trouble a recursive parser is refused before parsing. */
	for (int i = 0; i < 100; i++) {
		deep[used++] = '[';
	}
	deep[used] = '\0';
	CHECK(parse(deep, &job) == OTA_JOB_MALFORMED);
	CHECK(parse(reply("job-1", "QUEUED", "{\"a\":{\"b\":{\"c\":{\"d\":{\"e\":{}}}}}}"), &job) ==
	      OTA_JOB_MALFORMED);
}

static void test_refused_documents(void)
{
	struct ota_job job;
	char long_url[4096];

	/* A refusal still identifies the job, so that the device can answer it. */
	CHECK(parse(reply("job-7", "IN_PROGRESS", "{}"), &job) == OTA_JOB_UNSUPPORTED);
	CHECK(strcmp(job.id, "job-7") == 0 && job.in_progress);
	CHECK(job.size == 0 && job.host[0] == '\0');

	CHECK(parse_doc("7") == OTA_JOB_BAD_DOCUMENT);
	CHECK(parse_doc("null") == OTA_JOB_BAD_DOCUMENT);
	CHECK(parse_doc(doc("reboot", "1", "1.2.3+4", "1", SHA, URL)) == OTA_JOB_UNSUPPORTED);
	CHECK(parse_doc(doc("fw_update", "2", "1.2.3+4", "1", SHA, URL)) == OTA_JOB_UNSUPPORTED);
	CHECK(parse_doc(doc("fw_update", "\"1\"", "1.2.3+4", "1", SHA, URL)) == OTA_JOB_UNSUPPORTED);
	CHECK(parse_doc("{\"op\":\"fw_update\",\"v\":1}") == OTA_JOB_BAD_DOCUMENT);

	/* Version */
	CHECK(parse_doc(doc("fw_update", "1", "1.2", "1", SHA, URL)) == OTA_JOB_BAD_DOCUMENT);
	CHECK(parse_doc(doc("fw_update", "1", "v1.2.3", "1", SHA, URL)) == OTA_JOB_BAD_DOCUMENT);
	CHECK(parse_doc(doc("fw_update", "1", "256.0.0", "1", SHA, URL)) == OTA_JOB_BAD_DOCUMENT);

	/* Size */
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "0", SHA, URL)) == OTA_JOB_BAD_DOCUMENT);
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "-5", SHA, URL)) == OTA_JOB_BAD_DOCUMENT);
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "10.5", SHA, URL)) == OTA_JOB_BAD_DOCUMENT);
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "4294967296", SHA, URL)) ==
	      OTA_JOB_BAD_DOCUMENT);
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "1e99", SHA, URL)) == OTA_JOB_BAD_DOCUMENT);
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "\"100\"", SHA, URL)) == OTA_JOB_BAD_DOCUMENT);

	/* Digest: exactly 64 lowercase hex digits */
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "1", "abcd", URL)) == OTA_JOB_BAD_DOCUMENT);
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "1",
			    "99543F2F1A12346C1C755193EA21687F80B781DA56BEDAA5C0F1D2A3B4C5D6E7",
			    URL)) == OTA_JOB_BAD_DOCUMENT);
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "1",
			    "zz543f2f1a12346c1c755193ea21687f80b781da56bedaa5c0f1d2a3b4c5d6e7",
			    URL)) == OTA_JOB_BAD_DOCUMENT);

	/* Download location: only the provisioned prefix, only HTTPS */
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "1", SHA,
			    "http://fw-bucket.s3.us-east-1.amazonaws.com/firmware/x.bin")) ==
	      OTA_JOB_URL_NOT_ALLOWED);
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "1", SHA,
			    "https://fw-bucket.s3.us-east-1.amazonaws.com.evil.example/firmware/x")) ==
	      OTA_JOB_URL_NOT_ALLOWED);
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "1", SHA,
			    "https://evil.example/firmware/x.bin")) == OTA_JOB_URL_NOT_ALLOWED);
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "1", SHA,
			    "https://fw-bucket.s3.us-east-1.amazonaws.com/other/x.bin")) ==
	      OTA_JOB_URL_NOT_ALLOWED);
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "1", SHA,
			    "https://user@fw-bucket.s3.us-east-1.amazonaws.com/firmware/x")) ==
	      OTA_JOB_URL_NOT_ALLOWED);
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "1", SHA, PREFIX)) ==
	      OTA_JOB_URL_NOT_ALLOWED);
	/* An unsubstituted placeholder is not a URL. */
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "1", SHA,
			    "${aws:iot:s3-presigned-url-v2:https://s3.us-east-1.amazonaws.com/b/k}")) ==
	      OTA_JOB_URL_NOT_ALLOWED);

	/* Characters the download client would misread */
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "1", SHA, PREFIX "a:b.bin")) ==
	      OTA_JOB_BAD_DOCUMENT);
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "1", SHA, PREFIX "a//b.bin")) ==
	      OTA_JOB_BAD_DOCUMENT);
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "1", SHA, PREFIX "a.bin#frag")) ==
	      OTA_JOB_BAD_DOCUMENT);
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "1", SHA, PREFIX "a b.bin")) ==
	      OTA_JOB_BAD_DOCUMENT);
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "1", SHA, PREFIX "a\\nb.bin")) ==
	      OTA_JOB_BAD_DOCUMENT);

	/* Longer than the download client can request: refused, never truncated. */
	memset(long_url, 'a', sizeof(long_url));
	memcpy(long_url, PREFIX, strlen(PREFIX));
	long_url[strlen("https://fw-bucket.s3.us-east-1.amazonaws.com/") + OTA_JOB_FILE_MAX + 1] = '\0';
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "1", SHA, long_url)) == OTA_JOB_BAD_DOCUMENT);
	long_url[strlen("https://fw-bucket.s3.us-east-1.amazonaws.com/") + OTA_JOB_FILE_MAX] = '\0';
	CHECK(parse_doc(doc("fw_update", "1", "1.2.3", "1", SHA, long_url)) == OTA_JOB_OK);

	/* Without a usable prefix nothing may be downloaded. */
	CHECK(ota_job_parse(message, strlen(message), "", &job) == OTA_JOB_URL_NOT_ALLOWED);
	CHECK(ota_job_parse(message, strlen(message), "https://host-without-path", &job) ==
	      OTA_JOB_URL_NOT_ALLOWED);
	CHECK(ota_job_parse(message, strlen(message), "http://fw-bucket.example/firmware/", &job) ==
	      OTA_JOB_URL_NOT_ALLOWED);
}

static void test_policy(void)
{
	struct fw_version running;
	struct ota_job job = { .size = 1000 };

	CHECK(fw_version_parse("1.2.3+4", &running) == 0);

	CHECK(fw_version_parse("1.2.3+5", &job.version) == 0);
	CHECK(ota_job_check(&job, &running, 1000) == OTA_JOB_OK);
	CHECK(ota_job_check(&job, &running, 999) == OTA_JOB_TOO_LARGE);

	CHECK(fw_version_parse("1.2.3+4", &job.version) == 0);
	CHECK(ota_job_check(&job, &running, 1000) == OTA_JOB_NOT_NEWER);
	CHECK(fw_version_parse("1.2.2+99", &job.version) == 0);
	CHECK(ota_job_check(&job, &running, 1000) == OTA_JOB_NOT_NEWER);
	CHECK(fw_version_parse("0.9.9", &job.version) == 0);
	CHECK(ota_job_check(&job, &running, 1000) == OTA_JOB_NOT_NEWER);

	CHECK(strcmp(ota_job_result_reason(OTA_JOB_NOT_NEWER), "not_newer") == 0);
	CHECK(strcmp(ota_job_result_reason(OTA_JOB_URL_NOT_ALLOWED), "url_not_allowed") == 0);
	CHECK(strcmp(ota_job_result_reason(OTA_JOB_MALFORMED), "bad_document") == 0);
}

static void test_versions(void)
{
	static const char *const ordered[] = { "0.0.1",   "0.1.0",   "1.0.0",   "1.0.0+1",
					       "1.0.1",   "1.9.0",   "1.10.0",  "1.10.0+9",
					       "1.10.0+10", "2.0.0", "255.255.65535+4294967295" };
	static const char *const rejected[] = { "",        "1",        "1.2",      "1.2.3.4",
						"1.2.3+",  "+1",       "v1.2.3",   "1.2.3 ",
						" 1.2.3",  "01.2.3",   "1.02.3",   "1.2.3+04",
						"256.0.0", "0.256.0",  "0.0.65536", "0.0.0+4294967296",
						"1.2.3-rc1", "1.2.3+4+5", "1..3",  "1.2.3+-1",
						"99999999999.0.0" };
	struct fw_version a;
	struct fw_version b;
	char text[40];

	for (size_t i = 0; i < sizeof(ordered) / sizeof(ordered[0]); i++) {
		for (size_t j = 0; j < sizeof(ordered) / sizeof(ordered[0]); j++) {
			int order;

			CHECK(fw_version_parse(ordered[i], &a) == 0);
			CHECK(fw_version_parse(ordered[j], &b) == 0);
			order = fw_version_compare(&a, &b);
			CHECK((order < 0) == (i < j) && (order > 0) == (i > j));
		}
	}

	for (size_t i = 0; i < sizeof(rejected) / sizeof(rejected[0]); i++) {
		if (fw_version_parse(rejected[i], &a) == 0) {
			failures++;
			printf("FAIL: version \"%s\" was accepted\n", rejected[i]);
		}
		checks++;
	}
	CHECK(fw_version_parse(NULL, &a) != 0);

	CHECK(fw_version_parse("1.2.3", &a) == 0);
	CHECK(fw_version_to_string(&a, text, sizeof(text)) == 0 && strcmp(text, "1.2.3+0") == 0);
	CHECK(fw_version_parse("255.255.65535+4294967295", &a) == 0);
	CHECK(fw_version_to_string(&a, text, sizeof(text)) == 0 &&
	      strcmp(text, "255.255.65535+4294967295") == 0);
	CHECK(fw_version_to_string(&a, text, 5) < 0);
}

static void test_restart_outcomes(void)
{
	/* The target runs, on trial. */
	CHECK(ota_restart_outcome(true, true, true, false) == OTA_RESTART_ON_TRIAL);
	CHECK(ota_restart_outcome(true, true, true, true) == OTA_RESTART_ON_TRIAL);

	/* The target runs, confirmed earlier. */
	CHECK(ota_restart_outcome(true, false, true, true) == OTA_RESTART_CONFIRMED);
	CHECK(ota_restart_outcome(true, false, true, false) == OTA_RESTART_CONFIRMED);

	/* The target runs and its trailer is gone. It must not be reported as a success. */
	CHECK(ota_restart_outcome(true, false, false, true) == OTA_RESTART_TRIAL_LOST);
	CHECK(ota_restart_outcome(true, false, false, false) == OTA_RESTART_TRIAL_LOST);

	/* Another image runs, on trial or not: only the target's own trial counts. */
	CHECK(ota_restart_outcome(false, true, true, true) == OTA_RESTART_ROLLED_BACK);
	CHECK(ota_restart_outcome(false, true, true, false) == OTA_RESTART_NOT_INSTALLED);
	CHECK(ota_restart_outcome(false, false, true, true) == OTA_RESTART_ROLLED_BACK);
	CHECK(ota_restart_outcome(false, false, false, true) == OTA_RESTART_ROLLED_BACK);
	CHECK(ota_restart_outcome(false, false, true, false) == OTA_RESTART_NOT_INSTALLED);
	CHECK(ota_restart_outcome(false, false, false, false) == OTA_RESTART_NOT_INSTALLED);
}

int main(void)
{
	test_valid_job();
	test_document_as_string();
	test_no_job_and_malformed();
	test_refused_documents();
	test_policy();
	test_versions();
	test_restart_outcomes();

	printf("%d checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
