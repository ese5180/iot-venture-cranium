#include "cloud.h"

#include <errno.h>
#include <string.h>

#include <net/aws_iot.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/mqtt.h>
#include <zephyr/sys/atomic.h>

#include "app_events.h"
#include "identity.h"

LOG_MODULE_REGISTER(cloud, CONFIG_APP_LOG_LEVEL);

#define TOPIC_MAX        128
#define SHADOW_MAX       512
#define CONNECT_STACK    4096
#define CONNECT_PRIORITY K_PRIO_PREEMPT(10)

static char topic_notify_next[TOPIC_MAX];
static char topic_get_accepted[TOPIC_MAX];
static char topic_get_rejected[TOPIC_MAX];
static char topic_update_accepted[TOPIC_MAX];
static char topic_update_rejected[TOPIC_MAX];
static char topic_get_next[TOPIC_MAX];

static struct mqtt_topic subscriptions[5];

static K_THREAD_STACK_DEFINE(connect_stack, CONNECT_STACK);
static struct k_work_q connect_queue;
static struct k_work connect_work;

static atomic_t connected;
static atomic_t connecting;

/* One jobs message at a time is handed to the main loop. */
static char job_payload[CONFIG_MQTT_HELPER_PAYLOAD_BUFFER_LEN + 1];
static size_t job_payload_len;
static enum cloud_job_message job_kind;
static atomic_t job_busy;
static atomic_t job_overrun;

static bool ends_with(const char *text, size_t text_len, const char *suffix)
{
	size_t suffix_len = strlen(suffix);

	return text_len >= suffix_len &&
	       memcmp(text + text_len - suffix_len, suffix, suffix_len) == 0;
}

/*
 * Copy the value of a string member out of a small JSON reply from AWS IoT. This is
 * not a parser: it finds "name" followed by a colon and a quoted value without
 * escapes, which is all that tokens and error codes are.
 */
static bool json_string(const char *json, size_t len, const char *name, char *out,
			size_t out_size)
{
	size_t name_len = strlen(name);

	for (size_t i = 1; i + name_len + 1 < len; i++) {
		size_t at;
		size_t used = 0;

		if (json[i - 1] != '"' || (i >= 2 && json[i - 2] == '\\') ||
		    memcmp(json + i, name, name_len) != 0 || json[i + name_len] != '"') {
			continue;
		}

		at = i + name_len + 1;
		while (at < len && (json[at] == ' ' || json[at] == '\t')) {
			at++;
		}
		if (at >= len || json[at] != ':') {
			continue;
		}
		at++;
		while (at < len && (json[at] == ' ' || json[at] == '\t')) {
			at++;
		}
		if (at >= len || json[at] != '"') {
			return false;
		}
		at++;

		while (at < len && json[at] != '"') {
			if (json[at] == '\\' || used + 1 >= out_size) {
				return false;
			}
			out[used++] = json[at++];
		}
		if (at >= len) {
			return false;
		}

		out[used] = '\0';
		return true;
	}

	return false;
}

/* The reply to a job status update: hand it over if the update logic waits for it. */
static void on_update_reply(bool accepted, const char *payload, size_t len)
{
	struct app_event event = { .type = APP_EVENT_JOB_ACK, .job_ack.accepted = accepted };
	char token[12];
	char code[32];
	unsigned int sequence = 0;

	if (!accepted) {
		LOG_WRN("Job update rejected: %.*s", (int)MIN(len, 160), payload);
	}

	if (!json_string(payload, len, "clientToken", token, sizeof(token)) || token[1] == '\0') {
		return;
	}

	for (const char *digit = token + 1; *digit != '\0'; digit++) {
		if (*digit < '0' || *digit > '9') {
			return;
		}
		sequence = sequence * 10 + (unsigned int)(*digit - '0');
	}

	event.job_ack.kind = token[0];
	event.job_ack.sequence = (uint16_t)sequence;

	/* Everything except a busy or failing service is final: the execution was
	 * cancelled, timed out or deleted, or the request itself is not acceptable.
	 */
	event.job_ack.permanent = !accepted &&
		!(json_string(payload, len, "code", code, sizeof(code)) &&
		  (strcmp(code, "RequestThrottled") == 0 || strcmp(code, "InternalError") == 0 ||
		   strcmp(code, "ServiceUnavailable") == 0));

	(void)app_event_post(&event);
}

static void queue_job_message(enum cloud_job_message kind, const char *payload, size_t len)
{
	if (len >= sizeof(job_payload)) {
		LOG_WRN("Jobs message of %u bytes is too large and was dropped", (unsigned int)len);
		return;
	}

	if (!atomic_cas(&job_busy, 0, 1)) {
		atomic_set(&job_overrun, 1);
		return;
	}

	memcpy(job_payload, payload, len);
	job_payload[len] = '\0';
	job_payload_len = len;
	job_kind = kind;

	if (app_event_post_simple(APP_EVENT_JOB_MESSAGE) != 0) {
		atomic_set(&job_busy, 0);
		atomic_set(&job_overrun, 1);
	}
}

static void on_message(const char *topic, size_t topic_len, const char *payload, size_t len)
{
	if (ends_with(topic, topic_len, "/jobs/notify-next")) {
		/* Only a signal. Its copy of the document has no usable download URL. */
		queue_job_message(CLOUD_JOB_NOTIFY_NEXT, "", 0);
	} else if (ends_with(topic, topic_len, "/jobs/$next/get/accepted")) {
		queue_job_message(CLOUD_JOB_GET_ACCEPTED, payload, len);
	} else if (ends_with(topic, topic_len, "/jobs/$next/get/rejected")) {
		queue_job_message(CLOUD_JOB_GET_REJECTED, payload, len);
	} else if (ends_with(topic, topic_len, "/update/accepted")) {
		on_update_reply(true, payload, len);
	} else if (ends_with(topic, topic_len, "/update/rejected")) {
		on_update_reply(false, payload, len);
	}
}

static void on_aws_iot_event(const struct aws_iot_evt *const event)
{
	switch (event->type) {
	case AWS_IOT_EVT_CONNECTED:
		atomic_set(&connected, 1);
		(void)app_event_post_simple(APP_EVENT_CLOUD_UP);
		break;
	case AWS_IOT_EVT_DISCONNECTED:
		if (atomic_set(&connected, 0)) {
			(void)app_event_post_simple(APP_EVENT_CLOUD_DOWN);
		}
		break;
	case AWS_IOT_EVT_DATA_RECEIVED:
		on_message(event->data.msg.topic.str, event->data.msg.topic.len,
			   event->data.msg.ptr, event->data.msg.len);
		break;
	case AWS_IOT_EVT_ERROR:
		/* The library has already closed the connection. Reconnecting is the main
		 * loop's decision; a cloud problem must never reboot the device.
		 */
		LOG_WRN("AWS IoT library error %d", event->data.err);
		if (atomic_set(&connected, 0)) {
			(void)app_event_post_simple(APP_EVENT_CLOUD_DOWN);
		}
		break;
	default:
		break;
	}
}

static void connect_work_handler(struct k_work *work)
{
	const struct identity_settings *config = identity_settings_get();
	int err;

	ARG_UNUSED(work);

	if (config == NULL) {
		atomic_set(&connecting, 0);
		return;
	}

	struct aws_iot_config aws_config = {
		.client_id = (char *)identity_thing_name(),
		.host_name = (char *)config->endpoint,
	};

	LOG_INF("Connecting to AWS IoT as %s", identity_thing_name());

	/* Blocks until the broker has acknowledged the subscriptions, or fails. */
	err = aws_iot_connect(&aws_config);
	atomic_set(&connecting, 0);

	if (err) {
		LOG_WRN("Connection to AWS IoT failed: %d", err);
		if (!atomic_get(&connected)) {
			(void)app_event_post_simple(APP_EVENT_CLOUD_DOWN);
		}
	}
}

static int build_topic(char *buf, const char *suffix)
{
	int written = snprintk(buf, TOPIC_MAX, "$aws/things/%s/jobs/%s", identity_thing_name(),
			       suffix);

	return (written < 0 || written >= TOPIC_MAX) ? -ENOSPC : 0;
}

static void subscribe_to(size_t index, const char *topic)
{
	subscriptions[index].topic.utf8 = topic;
	subscriptions[index].topic.size = strlen(topic);
	subscriptions[index].qos = MQTT_QOS_1_AT_LEAST_ONCE;
}

int cloud_init(void)
{
	int err;

	err = build_topic(topic_notify_next, "notify-next");
	err = err ? err : build_topic(topic_get_accepted, "$next/get/accepted");
	err = err ? err : build_topic(topic_get_rejected, "$next/get/rejected");
	err = err ? err : build_topic(topic_update_accepted, "+/update/accepted");
	err = err ? err : build_topic(topic_update_rejected, "+/update/rejected");
	err = err ? err : build_topic(topic_get_next, "$next/get");
	if (err) {
		return err;
	}

	subscribe_to(0, topic_notify_next);
	subscribe_to(1, topic_get_accepted);
	subscribe_to(2, topic_get_rejected);
	subscribe_to(3, topic_update_accepted);
	subscribe_to(4, topic_update_rejected);

	err = aws_iot_init(on_aws_iot_event);
	if (err) {
		LOG_ERR("AWS IoT library could not be initialised: %d", err);
		return err;
	}

	err = aws_iot_application_topics_set(subscriptions, ARRAY_SIZE(subscriptions));
	if (err) {
		return err;
	}

	k_work_queue_init(&connect_queue);
	k_work_queue_start(&connect_queue, connect_stack, K_THREAD_STACK_SIZEOF(connect_stack),
			   CONNECT_PRIORITY, NULL);
	k_work_init(&connect_work, connect_work_handler);
	return 0;
}

void cloud_connect(void)
{
	if (atomic_get(&connected) || !atomic_cas(&connecting, 0, 1)) {
		return;
	}

	(void)k_work_submit_to_queue(&connect_queue, &connect_work);
}

void cloud_disconnect(void)
{
	if (atomic_get(&connected)) {
		(void)aws_iot_disconnect();
	}
}

bool cloud_is_connected(void)
{
	return atomic_get(&connected) != 0;
}

static int publish(const char *topic, enum aws_iot_shadow_topic_type shadow_topic,
		   const char *payload)
{
	struct aws_iot_data message = {
		.qos = MQTT_QOS_1_AT_LEAST_ONCE,
		.topic.type = shadow_topic,
		.topic.str = topic,
		.topic.len = topic ? strlen(topic) : 0,
		.ptr = (char *)payload,
		.len = strlen(payload),
	};

	if (!atomic_get(&connected)) {
		return -ENOTCONN;
	}

	return aws_iot_send(&message);
}

int cloud_shadow_report(const char *reported_json)
{
	static char document[SHADOW_MAX];
	int written = snprintk(document, sizeof(document), "{\"state\":{\"reported\":%s}}",
			       reported_json);

	if (written < 0 || written >= (int)sizeof(document)) {
		return -ENOSPC;
	}

	return publish(NULL, AWS_IOT_SHADOW_TOPIC_UPDATE, document);
}

int cloud_jobs_request_next(void)
{
	return publish(topic_get_next, AWS_IOT_SHADOW_TOPIC_NONE, "{}");
}

int cloud_jobs_update(const char *job_id, const char *body_json)
{
	char topic[TOPIC_MAX];
	int written = snprintk(topic, sizeof(topic), "$aws/things/%s/jobs/%s/update",
			       identity_thing_name(), job_id);

	if (written < 0 || written >= (int)sizeof(topic)) {
		return -ENOSPC;
	}

	return publish(topic, AWS_IOT_SHADOW_TOPIC_NONE, body_json);
}

bool cloud_job_message_get(enum cloud_job_message *kind, const char **payload, size_t *len)
{
	if (!atomic_get(&job_busy)) {
		return false;
	}

	*kind = job_kind;
	*payload = job_payload;
	*len = job_payload_len;
	return true;
}

bool cloud_job_message_done(void)
{
	atomic_set(&job_busy, 0);
	return atomic_set(&job_overrun, 0) != 0;
}
