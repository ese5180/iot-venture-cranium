/*
 * Parsing and checking of firmware-update job documents.
 *
 * Everything in a job message is input from outside the device. This module has no
 * side effects and no hardware dependencies, so it can be tested on a host.
 *
 * Job document format:
 *
 *   {
 *     "op": "fw_update",
 *     "v": 1,
 *     "fw": {
 *       "version": "1.2.0+7",
 *       "size": 712345,
 *       "sha256": "<64 hex digits>",
 *       "url": "https://<host>/<path>?<query>"
 *     }
 *   }
 */

#ifndef OTA_JOB_H_
#define OTA_JOB_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "version.h"

#define OTA_JOB_ID_MAX   64
#define OTA_SHA256_SIZE  32
/* "https://" and a host name of up to 255 characters. */
#define OTA_JOB_HOST_MAX 263
/* Path and query string: the limit of the HTTP download client. */
#define OTA_JOB_FILE_MAX 2047

struct ota_job {
	char id[OTA_JOB_ID_MAX + 1];
	/* The cloud lists this execution as in progress; otherwise it is still queued. */
	bool in_progress;
	struct fw_version version;
	uint32_t size;
	uint8_t sha256[OTA_SHA256_SIZE];
	/* "https://" followed by the host name. */
	char host[OTA_JOB_HOST_MAX + 1];
	/* Everything after the slash that follows the host name. */
	char file[OTA_JOB_FILE_MAX + 1];
};

enum ota_job_result {
	OTA_JOB_OK = 0,
	/* The message carries no job execution: nothing is pending. */
	OTA_JOB_NONE,
	/* Not usable and not attributable to a job, so it cannot even be refused. */
	OTA_JOB_MALFORMED,
	/* The job is identified (job->id is valid) but its document is not acceptable. */
	OTA_JOB_BAD_DOCUMENT,
	OTA_JOB_UNSUPPORTED,
	OTA_JOB_URL_NOT_ALLOWED,
	OTA_JOB_NOT_NEWER,
	OTA_JOB_TOO_LARGE,
};

/*
 * Parse the reply to a request for the next job execution.
 *
 * allowed_url_prefix is the only place firmware may be downloaded from; it must start
 * with "https://" and contain the complete host name followed by a slash.
 *
 * On OTA_JOB_OK every field of job is valid. On OTA_JOB_BAD_DOCUMENT,
 * OTA_JOB_UNSUPPORTED and OTA_JOB_URL_NOT_ALLOWED only job->id and job->in_progress
 * are valid.
 */
enum ota_job_result ota_job_parse(const char *json, size_t len, const char *allowed_url_prefix,
				  struct ota_job *job);

/*
 * Policy for a parsed job: it must be strictly newer than the running firmware and
 * fit in the image slot.
 */
enum ota_job_result ota_job_check(const struct ota_job *job, const struct fw_version *running,
				  size_t slot_size);

/* Short machine-readable reason, used in the status sent back to the cloud. */
const char *ota_job_result_reason(enum ota_job_result result);

/* What a stored record of an update means, once the device has restarted. */
enum ota_restart_outcome {
	/* The target runs and has yet to prove itself. */
	OTA_RESTART_ON_TRIAL,
	/* The target runs and was confirmed earlier: the report did not get out. */
	OTA_RESTART_CONFIRMED,
	/* The target runs with no trailer, so with nothing to revert to, and nothing proved it. */
	OTA_RESTART_TRIAL_LOST,
	/* Another image runs, and the target had started: the bootloader went back. */
	OTA_RESTART_ROLLED_BACK,
	/* Another image runs, and the target never started. */
	OTA_RESTART_NOT_INSTALLED,
};

/*
 * running_target: the running version is the one in the record. on_trial: the bootloader will
 * revert this image unless it is confirmed. has_trailer: the primary slot has a trailer, which a
 * swap always leaves, so a confirmed update has one. An image with none got there another way,
 * for example a golden image restore that was cut off just after it erased the trailer.
 * was_testing: the record says that the target has started.
 */
enum ota_restart_outcome ota_restart_outcome(bool running_target, bool on_trial, bool has_trailer,
					     bool was_testing);

#endif /* OTA_JOB_H_ */
