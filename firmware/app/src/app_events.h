/*
 * Events handled by the application's single event loop.
 *
 * Library callbacks run on several threads (MQTT, downloader, input, network
 * management), and the serial console has a task of its own. They only post one of
 * these events; every state change then happens on the main thread, one event at a time.
 */

#ifndef APP_EVENTS_H_
#define APP_EVENTS_H_

#include <stdbool.h>
#include <stdint.h>

enum app_event_type {
	APP_EVENT_NET_UP,
	APP_EVENT_NET_DOWN,
	/* Start joining the stored network. */
	APP_EVENT_NET_JOIN,
	/* An attempt to join did not work out. */
	APP_EVENT_NET_JOIN_FAILED,
	APP_EVENT_CLOUD_UP,
	APP_EVENT_CLOUD_DOWN,
	/* The cloud settings have changed: connect again soon, with the new ones. */
	APP_EVENT_CLOUD_CHANGED,
	/* A jobs message (the next job, or the reply to a request for it) is waiting. */
	APP_EVENT_JOB_MESSAGE,
	/* AWS IoT answered a job status update that the update logic is waiting on. */
	APP_EVENT_JOB_ACK,
	APP_EVENT_BUTTON,
	APP_EVENT_DOWNLOAD,
	/* Once a second. */
	APP_EVENT_TICK,
	/* Run a function here: how the console task reads and changes what this loop owns. */
	APP_EVENT_CALL,
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
#if defined(CONFIG_APP_BT_OTA)
			/* A real press of a real button, not a command on the console. */
			bool physical;
#endif
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
		struct {
			int16_t reason;
		} join_failed;
		struct {
			void (*function)(void);
		} call;
	};
};

/* Queue an event for the main loop. Safe from any thread and from interrupts. */
int app_event_post(const struct app_event *event);

/* Shorthand for events that carry no data. */
int app_event_post_simple(enum app_event_type type);

#endif /* APP_EVENTS_H_ */
