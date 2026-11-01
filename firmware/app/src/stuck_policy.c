#include "stuck_policy.h"

#include <string.h>

const char *stuck_reason_text(enum stuck_reason reason)
{
	switch (reason) {
	case STUCK_REASON_WIFI_SILENT:
		return "wifi_silent";
	case STUCK_REASON_NO_CLOUD:
		return "no_cloud";
	case STUCK_REASON_UPDATE_STALL:
		return "update_stall";
	default:
		return "none";
	}
}

bool stuck_gate_open(const struct stuck_board *board, enum stuck_reason timer)
{
	if (board->factory || !board->network_stored || !board->provisioned || board->trial ||
	    board->bt_window) {
		return false;
	}

	/*
	 * Every update state other than these two has a limit of its own now, so the timers for
	 * Wi-Fi and the cloud can leave those to it. There is no hold-off for use of the console:
	 * a test bench polls it, which would hold a restart off for as long as the bench waits for
	 * one, and a restart in the middle of a stream only means that the stream is sent again.
	 */
	return timer == STUCK_REASON_UPDATE_STALL || board->update == STUCK_UPDATE_NONE;
}

uint32_t stuck_min_uptime_seconds(uint8_t count)
{
	switch (count) {
	case 0:
		return 0;
	case 1:
		return 5 * 60;
	case 2:
		return 30 * 60;
	case 3:
		return 2 * 60 * 60;
	default:
		return 6 * 60 * 60;
	}
}

void stuck_state_init(struct stuck_state *state, const struct stuck_record *record,
		      uint32_t uptime_seconds)
{
	memset(state, 0, sizeof(*state));
	state->last_uptime = uptime_seconds;

	if (record != NULL && record->magic == STUCK_RECORD_MAGIC &&
	    record->count <= STUCK_COUNT_MAX && record->reason <= STUCK_REASON_UPDATE_STALL) {
		state->count = record->count;
		state->reason = (enum stuck_reason)record->reason;
	}
}

void stuck_settings_changed(struct stuck_state *state)
{
	state->no_cloud_seconds = 0;
}

struct stuck_record stuck_record_of(const struct stuck_state *state)
{
	struct stuck_record record;

	memset(&record, 0, sizeof(record));
	record.magic = STUCK_RECORD_MAGIC;
	record.count = state->count;
	record.reason = (uint8_t)state->reason;
	return record;
}

/* The timers. Each starts over when its gate is closed, so a gate that opens never ends in a restart. */
static void run_timers(struct stuck_state *state, const struct stuck_board *board, uint32_t elapsed,
		       bool answered, bool progress)
{
	if (board->link_up) {
		state->link_down_seconds = 0;
	} else {
		state->link_down_seconds += elapsed;
	}

	if (!stuck_gate_open(board, STUCK_REASON_WIFI_SILENT) || board->link_up || answered) {
		state->silent_seconds = 0;
	} else {
		state->silent_seconds += elapsed;
	}

	if (!stuck_gate_open(board, STUCK_REASON_NO_CLOUD) || board->cloud_up ||
	    state->link_down_seconds >= STUCK_LINK_GONE_SECONDS) {
		state->no_cloud_seconds = 0;
	} else if (board->link_up) {
		state->no_cloud_seconds += elapsed;
	}

	if (!stuck_gate_open(board, STUCK_REASON_UPDATE_STALL) ||
	    board->update != STUCK_UPDATE_WATCHED || progress) {
		state->stall_seconds = 0;
	} else {
		state->stall_seconds += elapsed;
	}
}

/*
 * Well means well now as well as earlier in this boot. A chip that answered once and hung soon
 * after has its proof and its 30 minutes when the back-off of 30 minutes runs out, and clearing
 * the count then would undo the back-off. So would a hotspot with no internet, on which the
 * stack keeps answering and the cloud never comes. So no timer may be past its limit.
 */
static bool board_is_well(const struct stuck_state *state, const struct stuck_board *board)
{
	return state->proof && board->uptime_seconds >= STUCK_HEALTHY_SECONDS &&
	       state->silent_seconds < STUCK_WIFI_SILENT_SECONDS &&
	       state->no_cloud_seconds < STUCK_NO_CLOUD_SECONDS;
}

static enum stuck_reason timer_past_its_limit(const struct stuck_state *state,
					      const struct stuck_board *board)
{
	if (state->stall_seconds >= STUCK_UPDATE_STALL_SECONDS) {
		return STUCK_REASON_UPDATE_STALL;
	}

	if (state->silent_seconds >= STUCK_WIFI_SILENT_SECONDS) {
		return STUCK_REASON_WIFI_SILENT;
	}

	if (board->link_up && state->no_cloud_seconds >= STUCK_NO_CLOUD_SECONDS) {
		return STUCK_REASON_NO_CLOUD;
	}

	return STUCK_REASON_NONE;
}

static uint32_t restart(struct stuck_state *state, enum stuck_reason reason)
{
	/* From here on this record does not change, and it is not written either. */
	bool write = state->count < STUCK_COUNT_MAX;

	state->reason = reason;
	state->restarting = true;

	/* An update stall needs a job under way, so it cannot go round in a loop by itself. */
	if (write && reason != STUCK_REASON_UPDATE_STALL) {
		state->count++;
	}

	return STUCK_DO_RESTART | (write ? STUCK_DO_WRITE : 0);
}

uint32_t stuck_tick(struct stuck_state *state, const struct stuck_board *board)
{
	uint32_t elapsed = board->uptime_seconds - state->last_uptime;
	bool answered = board->wifi_answers != state->wifi_answers_seen;
	bool progress = board->update_progress != state->update_progress_seen;
	enum stuck_reason reason;

	state->last_uptime = board->uptime_seconds;
	state->wifi_answers_seen = board->wifi_answers;
	state->update_progress_seen = board->update_progress;
	state->proof = state->proof || answered || board->cloud_up;

	if (state->restarting) {
		return 0;
	}

	run_timers(state, board, elapsed, answered, progress);

	if (state->count > 0 || state->reason != STUCK_REASON_NONE) {
		if (board_is_well(state, board)) {
			state->count = 0;
			state->reason = STUCK_REASON_NONE;
			return STUCK_DO_ERASE;
		}
	}

	reason = timer_past_its_limit(state, board);

	if (reason == STUCK_REASON_UPDATE_STALL ||
	    (reason != STUCK_REASON_NONE &&
	     board->uptime_seconds >= stuck_min_uptime_seconds(state->count))) {
		return restart(state, reason);
	}

	return 0;
}
