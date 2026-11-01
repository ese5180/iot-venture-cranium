/*
 * Connection to AWS IoT Core: MQTT over TLS with mutual authentication.
 *
 * The device talks only to its own shadow and its own jobs topics. The endpoint and
 * the client ID (the thing name) are provisioned per device.
 */

#ifndef CLOUD_H_
#define CLOUD_H_

#include <stdbool.h>
#include <stddef.h>

enum cloud_job_message {
	/* The list of pending job executions changed. Carries no payload: the document
	 * is always fetched with cloud_jobs_request_next(), which also signs a fresh URL.
	 */
	CLOUD_JOB_NOTIFY_NEXT,
	/* Reply to cloud_jobs_request_next(). */
	CLOUD_JOB_GET_ACCEPTED,
	CLOUD_JOB_GET_REJECTED,
};

int cloud_init(void);

/* Start connecting in the background. APP_EVENT_CLOUD_UP or _DOWN follows. */
void cloud_connect(void);
void cloud_disconnect(void);
bool cloud_is_connected(void);

/* An attempt is running: APP_EVENT_CLOUD_UP or _DOWN is still to come. */
bool cloud_is_connecting(void);

/* Publish the reported state. json is the object that goes under state.reported. */
int cloud_shadow_report(const char *reported_json);

/* Ask for the next pending job execution, including a fresh job document. */
int cloud_jobs_request_next(void);

/*
 * Update a job execution. body_json is the complete request body. If it carries a
 * "clientToken" of one letter followed by a number, the reply arrives as
 * APP_EVENT_JOB_ACK with that letter and number.
 */
int cloud_jobs_update(const char *job_id, const char *body_json);

/*
 * Access to the jobs message announced by APP_EVENT_JOB_MESSAGE. The payload stays
 * valid until cloud_job_message_done(); messages that arrive in between are dropped,
 * which cloud_job_message_done() reports so that the caller can ask again.
 */
bool cloud_job_message_get(enum cloud_job_message *kind, const char **payload, size_t *len);
bool cloud_job_message_done(void);

#endif /* CLOUD_H_ */
