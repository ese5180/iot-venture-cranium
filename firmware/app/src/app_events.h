/*
 * Events handled by the application's single event loop.
 *
 * Library callbacks run on several threads (MQTT, downloader, input, network
 * management). They only post one of these events; every state change then happens
 * on the main thread, one event at a time.
 */

#ifndef APP_EVENTS_H_
#define APP_EVENTS_H_

#include <stdbool.h>
#include <stdint.h>

enum app_event_type {
	APP_EVENT_NET_UP,
	APP_EVENT_NET_DOWN,
	APP_EVENT_CLOUD_UP,
	APP_EVENT_CLOUD_DOWN,
	/* A jobs message (the next job, or the reply to a request for it) is waiting. */
	APP_EVENT_JOB_MESSAGE,
	/* AWS IoT answered a job status update that the update logic is waiting on. */
	APP_EVENT_JOB_ACK,
	APP_EVENT_BUTTON,
	APP_EVENT_DOWNLOAD,
	/* Once a second. */
	APP_EVENT_TICK,
};

enum app_button {
	APP_BUTTON_1,
	APP_BUTTON_2,
};

enum app_download_event {
	APP_DOWNLOAD_PROGRESS,
	APP_DOWNLOAD_FINISHED,
	APP_DOWNLOAD_ERROR,
	APP_DOWNLOAD_CANCELLED,
};

struct app_event {
	enum app_event_type type;
	union {
		struct {
			uint8_t id;
			bool long_press;
		} button;
		struct {
			uint8_t what;
			/* Percent for progress, library error cause for an error. */
			int16_t value;
		} download;
		struct {
			/* Which update this answers: the token it was sent with. */
			char kind;
			uint16_t sequence;
			bool accepted;
			/* Rejected for a reason that sending it again cannot change. */
			bool permanent;
		} job_ack;
	};
};

/* Queue an event for the main loop. Safe from any thread and from interrupts. */
int app_event_post(const struct app_event *event);

/* Shorthand for events that carry no data. */
int app_event_post_simple(enum app_event_type type);

#endif /* APP_EVENTS_H_ */
