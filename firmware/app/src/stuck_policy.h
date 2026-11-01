/*
 * When a board that is stuck gets restarted, with no Wi-Fi, cloud or kernel in it: the three
 * timers, what stands in their way, and how long the next restart has to wait. This module has
 * no side effects and no hardware dependencies, so it can be tested on a host.
 *
 * src/stuck.c does what these functions decide. firmware/README.md says why they decide it.
 */

#ifndef STUCK_POLICY_H_
#define STUCK_POLICY_H_

#include <stdbool.h>
#include <stdint.h>

/*
 * The link is down, a network is stored, and the Wi-Fi stack has said nothing about any join
 * for this long. Four retries of net_tick(), each of which can take a slow scan. A chip that
 * answers "network not found" has finished a scan, so a missing hotspot never gets here.
 *
 * Silence is the sign of a hung chip, and it is not proof of one, in either direction. hostap
 * reports a result for a network that is not found, for a four-way handshake that fails, for a
 * disconnect during a join and for a join that completes. An access point that can be seen and
 * refuses the join mostly gets none: a wrong WPA3 password, which fails before any handshake, a
 * hotspot that is full or filters addresses, or one at the edge of range. A healthy chip is then
 * restarted at the pace of the back-off, on a board that was offline anyway, and the count stays
 * until something answers. The other way round: hostap also gives up on a stored connect after
 * about 31 s with -ETIMEDOUT, which takes only the supplicant and not the chip. net_tick() asks
 * again before that and starts that clock over, as long as asking takes under about 2 s. A hung chip
 * that makes it take longer could hold this timer off. No such result came in the hang that was
 * seen. All of this comes from reading hostap, and it has not been run.
 *
 * A join that join_policy.h holds is no answer, and this timer goes on running while it is held. If
 * the link is up when the join is asked for, the link goes first: if the stack does not report that
 * within JOIN_LEAVE_LIMIT_MS, the link counts as gone, and this timer starts from there.
 *
 * SUPPLICANT_EVENT_SCAN_FAILED is not used, and that is a decision. As a way to get there sooner
 * it would make a restart more likely on a healthy chip, which reports it as well when a scan is
 * still running (the -EBUSY in wpa_supp_if.c). As a condition for a restart it would miss a chip
 * that never gets as far as a scan, such as one that refuses the request because its interface
 * did not come up. And it would add a callback on the network management thread, for an event
 * whose data does not outlive the call. Silence alone covers the hang that was seen.
 */
#define STUCK_WIFI_SILENT_SECONDS  120
/*
 * Link-up time with no cloud connection. It adds up over short drops of the link, so that a link
 * that flaps cannot hold it off. It starts over with a connection to the cloud, with new settings,
 * and when the link has been gone for STUCK_LINK_GONE_SECONDS. This is for a chip that hangs while
 * associated, where no disconnect event may ever come, and for a wedge on this side: a TLS heap
 * that ran out, a connect that never returns.
 */
#define STUCK_NO_CLOUD_SECONDS     (15 * 60)
/*
 * The link has been down for this long without a break, so what comes back is a new link and not a
 * flap. Without this, link-up time from long ago would restart a healthy board as soon as its
 * hotspot returned, before it had tried the cloud, and would keep the count from ever clearing.
 */
#define STUCK_LINK_GONE_SECONDS    (5 * 60)
/* An update that is under way and has not moved. Not cancelled: see firmware/README.md. */
#define STUCK_UPDATE_STALL_SECONDS 600
/* The count of restarts goes back to 0 after this much uptime on a board that is well. */
#define STUCK_HEALTHY_SECONDS      (30 * 60)
/* Where the count stops. It is not written from here on, so flash wear has a limit. */
#define STUCK_COUNT_MAX            4

enum stuck_reason {
	STUCK_REASON_NONE,
	STUCK_REASON_WIFI_SILENT,
	STUCK_REASON_NO_CLOUD,
	STUCK_REASON_UPDATE_STALL,
};

/* The word for the console, and for a test bench to look for. */
const char *stuck_reason_text(enum stuck_reason reason);

enum stuck_update {
	/* Idle, or an offer is waiting for a button. A restart loses nothing: an offer comes back. */
	STUCK_UPDATE_NONE,
	/* Under way, in a state that STUCK_UPDATE_STALL_SECONDS watches. */
	STUCK_UPDATE_WATCHED,
	/* Something else limits it: a check that runs on the main loop, a trial, a Bluetooth window. */
	STUCK_UPDATE_BOUNDED,
};

/* What the board is doing, as the main loop reads it once a second. */
struct stuck_board {
	uint32_t uptime_seconds;
	bool factory;
	bool network_stored;
	/* It has cloud settings, a device key and a certificate. */
	bool provisioned;
	/* An image is on trial. The trial's own deadline ends that. */
	bool trial;
	/* A Bluetooth update window is open, in a build that has them. */
	bool bt_window;
	enum stuck_update update;
	bool link_up;
	bool cloud_up;
	/* How many join results the Wi-Fi stack has reported since this image started, of any kind. */
	uint32_t wifi_answers;
	/* How many times the update under way has moved. See ota_stuck_progress(). */
	uint32_t update_progress;
};

/* The gate. False: this timer is held at its start, and it cannot restart the board. */
bool stuck_gate_open(const struct stuck_board *board, enum stuck_reason timer);

/* The least uptime before the next restart by WIFI_SILENT or NO_CLOUD, after this many. */
uint32_t stuck_min_uptime_seconds(uint8_t count);

#define STUCK_RECORD_MAGIC 0x53544b31U /* "STK1" */

/* What survives a restart, in TF-M storage. A record of one size only: see store_read(). */
struct stuck_record {
	uint32_t magic;
	uint8_t count;
	uint8_t reason;
	uint8_t reserved[2];
};

struct stuck_state {
	uint8_t count;
	enum stuck_reason reason;
	uint32_t last_uptime;
	uint32_t silent_seconds;
	uint32_t no_cloud_seconds;
	/* For how long the link has been down, whatever the gate says. */
	uint32_t link_down_seconds;
	uint32_t stall_seconds;
	uint32_t wifi_answers_seen;
	uint32_t update_progress_seen;
	/* Since this image started, the stack has answered or the cloud has connected. */
	bool proof;
	/* A restart has been decided. On the board there is no next tick. */
	bool restarting;
};

/*
 * The state at boot. record is NULL if it could not be read. A record that is missing, unreadable
 * or makes no sense counts as a count of 0, so it can never hold a restart off.
 */
void stuck_state_init(struct stuck_state *state, const struct stuck_record *record,
		      uint32_t uptime_seconds);

/* What the main loop has to do, as a bit mask. */
/* Write stuck_record_of(), before the restart. */
#define STUCK_DO_WRITE   (1U << 0)
/* The board is well again: remove the record. */
#define STUCK_DO_ERASE   (1U << 1)
/* Say why, with state->reason and state->count, and restart. */
#define STUCK_DO_RESTART (1U << 2)

/* Once a second, or as near to it as the main loop gets: it goes by uptime, not by calls. */
uint32_t stuck_tick(struct stuck_state *state, const struct stuck_board *board);

struct stuck_record stuck_record_of(const struct stuck_state *state);

/*
 * Somebody has just stored a network or cloud settings. Link-up time with the old ones says
 * nothing about the new ones, which get all of STUCK_NO_CLOUD_SECONDS. The silence stays as it
 * is: new settings do not wake a chip that has stopped answering.
 */
void stuck_settings_changed(struct stuck_state *state);

#endif /* STUCK_POLICY_H_ */
