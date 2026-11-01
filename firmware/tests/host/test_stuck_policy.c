/*
 * Host-side tests of what src/stuck_policy.c decides: when a board that is stuck gets restarted,
 * what keeps it from happening, and how long the next one has to wait. A wrong decision either
 * restarts a board that is fine, for ever if it is unlucky, or leaves one hanging with nobody
 * there. tests/host/mutate_stuck.py changes the policy in small ways and checks that this file
 * notices each one. How it is wired to the real main loop is for test_app.c.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "stuck_policy.h"

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

#define MINUTE 60U
#define HOUR   (60U * MINUTE)
#define DAY    (24U * HOUR)
#define MIN(a, b) ((a) < (b) ? (a) : (b))

static struct stuck_board board;
static struct stuck_state state;

/* A provisioned board, just started, whose link is down. Nobody has said anything yet. */
static void start(uint8_t count, enum stuck_reason reason)
{
	const struct stuck_record record = {
		.magic = STUCK_RECORD_MAGIC,
		.count = count,
		.reason = (uint8_t)reason,
	};

	memset(&board, 0, sizeof(board));
	board.network_stored = true;
	board.provisioned = true;
	board.update = STUCK_UPDATE_NONE;
	stuck_state_init(&state, &record, 0);
}

/* One tick, some time later. */
static uint32_t tick_after(uint32_t seconds)
{
	board.uptime_seconds += seconds;
	return stuck_tick(&state, &board);
}

/* A tick a second for this long. Returns what they asked for, all together. */
static uint32_t run(uint32_t seconds)
{
	uint32_t all = 0;

	for (uint32_t i = 0; i < seconds; i++) {
		all |= tick_after(1);
	}

	return all;
}

static uint32_t answer_and_tick(uint32_t seconds)
{
	board.wifi_answers++;
	return tick_after(seconds);
}

/* A stack that keeps answering for this long, as for a hotspot that is gone. */
static uint32_t answering_for(uint32_t seconds)
{
	uint32_t all = 0;

	for (uint32_t i = 0; i < seconds; i += 20) {
		all |= run(MIN(seconds - i, 20U) - 1);
		all |= answer_and_tick(1);
	}

	return all;
}

/* ---- the names ------------------------------------------------------------------- */

static void test_the_words_a_test_bench_looks_for(void)
{
	CHECK(strcmp(stuck_reason_text(STUCK_REASON_WIFI_SILENT), "wifi_silent") == 0);
	CHECK(strcmp(stuck_reason_text(STUCK_REASON_NO_CLOUD), "no_cloud") == 0);
	CHECK(strcmp(stuck_reason_text(STUCK_REASON_UPDATE_STALL), "update_stall") == 0);
	CHECK(strcmp(stuck_reason_text(STUCK_REASON_NONE), "none") == 0);
}

/* In numbers, because everything below goes by the names. These are what the documentation says. */
static void test_the_limits(void)
{
	CHECK(STUCK_WIFI_SILENT_SECONDS == 120);
	CHECK(STUCK_NO_CLOUD_SECONDS == 900);
	CHECK(STUCK_LINK_GONE_SECONDS == 300);
	CHECK(STUCK_UPDATE_STALL_SECONDS == 600);
	CHECK(STUCK_HEALTHY_SECONDS == 1800);
	CHECK(STUCK_COUNT_MAX == 4);
	CHECK(STUCK_RECORD_MAGIC == 0x53544b31U);
	CHECK(STUCK_DO_WRITE != 0 && STUCK_DO_ERASE != 0 && STUCK_DO_RESTART != 0);
	CHECK((STUCK_DO_WRITE & STUCK_DO_ERASE) == 0 && (STUCK_DO_WRITE & STUCK_DO_RESTART) == 0 &&
	      (STUCK_DO_ERASE & STUCK_DO_RESTART) == 0);
	CHECK(sizeof(struct stuck_record) == 8);
}

/* ---- the gate -------------------------------------------------------------------- */

static void test_the_gate_term_by_term(void)
{
	static const enum stuck_reason timers[] = { STUCK_REASON_WIFI_SILENT, STUCK_REASON_NO_CLOUD,
						    STUCK_REASON_UPDATE_STALL };

	for (size_t i = 0; i < sizeof(timers) / sizeof(timers[0]); i++) {
		start(0, STUCK_REASON_NONE);
		CHECK(stuck_gate_open(&board, timers[i]));

		board.factory = true;
		CHECK(!stuck_gate_open(&board, timers[i]));
		board.factory = false;

		board.network_stored = false;
		CHECK(!stuck_gate_open(&board, timers[i]));
		board.network_stored = true;

		board.provisioned = false;
		CHECK(!stuck_gate_open(&board, timers[i]));
		board.provisioned = true;

		board.trial = true;
		CHECK(!stuck_gate_open(&board, timers[i]));
		board.trial = false;

		board.bt_window = true;
		CHECK(!stuck_gate_open(&board, timers[i]));
		board.bt_window = false;

		CHECK(stuck_gate_open(&board, timers[i]));
	}
}

static void test_the_gate_and_the_update_state(void)
{
	start(0, STUCK_REASON_NONE);

	board.update = STUCK_UPDATE_NONE;
	CHECK(stuck_gate_open(&board, STUCK_REASON_WIFI_SILENT));
	CHECK(stuck_gate_open(&board, STUCK_REASON_NO_CLOUD));
	CHECK(stuck_gate_open(&board, STUCK_REASON_UPDATE_STALL));

	board.update = STUCK_UPDATE_WATCHED;
	CHECK(!stuck_gate_open(&board, STUCK_REASON_WIFI_SILENT));
	CHECK(!stuck_gate_open(&board, STUCK_REASON_NO_CLOUD));
	CHECK(stuck_gate_open(&board, STUCK_REASON_UPDATE_STALL));

	board.update = STUCK_UPDATE_BOUNDED;
	CHECK(!stuck_gate_open(&board, STUCK_REASON_WIFI_SILENT));
	CHECK(!stuck_gate_open(&board, STUCK_REASON_NO_CLOUD));
}

/* All three timers would be past their limit, if one of them could run at all. */
static void held_for_long_then_a_full_wait(bool *term)
{
	/* A chip that says nothing. */
	CHECK(run(2 * DAY) == 0);
	CHECK(state.count == 0);

	/* The link up, and no cloud. */
	board.link_up = true;
	CHECK(run(2 * DAY) == 0);
	board.link_up = false;

	/* An update that does not move. */
	board.update = STUCK_UPDATE_WATCHED;
	CHECK(run(2 * DAY) == 0);
	board.update = STUCK_UPDATE_NONE;

	CHECK(state.silent_seconds == 0);
	CHECK(state.no_cloud_seconds == 0);
	CHECK(state.stall_seconds == 0);

	/* When the gate opens, the timer starts from nothing. No restart comes as a surprise. */
	*term = !*term;
	CHECK(run(STUCK_WIFI_SILENT_SECONDS - 1) == 0);
	CHECK(run(1) & STUCK_DO_RESTART);
	CHECK(state.reason == STUCK_REASON_WIFI_SILENT);
}

static void test_what_never_restarts(void)
{
	start(0, STUCK_REASON_NONE);
	board.factory = true;
	held_for_long_then_a_full_wait(&board.factory);

	start(0, STUCK_REASON_NONE);
	board.network_stored = false;
	held_for_long_then_a_full_wait(&board.network_stored);

	start(0, STUCK_REASON_NONE);
	board.provisioned = false;
	held_for_long_then_a_full_wait(&board.provisioned);

	start(0, STUCK_REASON_NONE);
	board.trial = true;
	held_for_long_then_a_full_wait(&board.trial);

	start(0, STUCK_REASON_NONE);
	board.bt_window = true;
	held_for_long_then_a_full_wait(&board.bt_window);
}

/* ---- WIFI_SILENT ----------------------------------------------------------------- */

static void test_wifi_silent_at_its_limit(void)
{
	start(0, STUCK_REASON_NONE);
	CHECK(run(STUCK_WIFI_SILENT_SECONDS - 1) == 0);
	CHECK(state.silent_seconds == STUCK_WIFI_SILENT_SECONDS - 1);

	CHECK(tick_after(1) == (STUCK_DO_RESTART | STUCK_DO_WRITE));
	CHECK(state.reason == STUCK_REASON_WIFI_SILENT);
	CHECK(state.count == 1);

	/* A main loop that was held up comes back past the limit: the second after it is the same. */
	start(0, STUCK_REASON_NONE);
	CHECK(tick_after(STUCK_WIFI_SILENT_SECONDS + 1) & STUCK_DO_RESTART);

	/* And it goes by the time that went by, however few ticks there were. */
	start(0, STUCK_REASON_NONE);
	CHECK(tick_after(STUCK_WIFI_SILENT_SECONDS - 1) == 0);
	CHECK(tick_after(1) & STUCK_DO_RESTART);
}

static void test_the_first_answer_clears_the_silence(void)
{
	start(0, STUCK_REASON_NONE);
	CHECK(run(STUCK_WIFI_SILENT_SECONDS - 1) == 0);
	CHECK(answer_and_tick(1) == 0);
	CHECK(state.silent_seconds == 0);

	/* A full wait from there. */
	CHECK(run(STUCK_WIFI_SILENT_SECONDS - 1) == 0);
	CHECK(run(1) & STUCK_DO_RESTART);

	/* An answer in the very tick of the limit is still an answer. */
	start(0, STUCK_REASON_NONE);
	CHECK(run(STUCK_WIFI_SILENT_SECONDS - 1) == 0);
	CHECK(answer_and_tick(5) == 0);

	/* Any number of near misses do not add up. */
	start(0, STUCK_REASON_NONE);
	for (int i = 0; i < 100; i++) {
		CHECK(run(STUCK_WIFI_SILENT_SECONDS - 2) == 0);
		CHECK(answer_and_tick(1) == 0);
	}
	CHECK(state.count == 0);
}

static void test_a_link_that_is_up_is_not_silence(void)
{
	start(0, STUCK_REASON_NONE);
	CHECK(run(STUCK_WIFI_SILENT_SECONDS - 1) == 0);
	board.link_up = true;
	CHECK(run(1) == 0);
	CHECK(state.silent_seconds == 0);

	/* It counts from when the link goes down, not from whatever came before. */
	board.cloud_up = true;
	CHECK(run(HOUR) == 0);
	board.link_up = false;
	board.cloud_up = false;
	CHECK(run(STUCK_WIFI_SILENT_SECONDS - 1) == 0);
	CHECK(run(1) & STUCK_DO_RESTART);
}

static void test_a_missing_hotspot_never_restarts(void)
{
	/* A network that cannot be found gets a result after every scan, and a scan takes a while. */
	static const uint32_t gaps[] = { 1, 20, 30, 60, 119 };

	for (size_t i = 0; i < sizeof(gaps) / sizeof(gaps[0]); i++) {
		start(0, STUCK_REASON_NONE);

		for (uint32_t elapsed = 0; elapsed < 2 * DAY; elapsed += gaps[i]) {
			CHECK(run(gaps[i] - 1) == 0);
			CHECK(answer_and_tick(1) == 0);
		}

		CHECK(state.count == 0);
		CHECK(state.reason == STUCK_REASON_NONE);
	}
}

/* ---- NO_CLOUD -------------------------------------------------------------------- */

static void test_no_cloud_at_its_limit(void)
{
	start(0, STUCK_REASON_NONE);
	board.link_up = true;
	CHECK(run(STUCK_NO_CLOUD_SECONDS - 1) == 0);
	CHECK(tick_after(1) == (STUCK_DO_RESTART | STUCK_DO_WRITE));
	CHECK(state.reason == STUCK_REASON_NO_CLOUD);
	CHECK(state.count == 1);

	start(0, STUCK_REASON_NONE);
	board.link_up = true;
	CHECK(tick_after(STUCK_NO_CLOUD_SECONDS + 1) & STUCK_DO_RESTART);
}

static void test_a_cloud_connection_starts_no_cloud_over(void)
{
	start(0, STUCK_REASON_NONE);
	board.link_up = true;
	CHECK(run(STUCK_NO_CLOUD_SECONDS - 1) == 0);
	board.cloud_up = true;
	CHECK(run(1) == 0);
	CHECK(state.no_cloud_seconds == 0);
	board.cloud_up = false;
	CHECK(run(STUCK_NO_CLOUD_SECONDS - 1) == 0);
	CHECK(run(1) & STUCK_DO_RESTART);

	/* Connected for days. */
	start(0, STUCK_REASON_NONE);
	board.link_up = true;
	board.cloud_up = true;
	CHECK(run(2 * DAY) == 0);
}

static void test_no_cloud_adds_up_over_a_link_that_flaps(void)
{
	start(0, STUCK_REASON_NONE);
	board.link_up = true;
	CHECK(run(STUCK_NO_CLOUD_SECONDS - 100) == 0);

	/* The link goes, and the stack keeps answering. Only link-up time counts. */
	board.link_up = false;
	for (int i = 0; i < 9; i++) {
		CHECK(run(29) == 0);
		CHECK(answer_and_tick(1) == 0);
	}
	CHECK(state.no_cloud_seconds == STUCK_NO_CLOUD_SECONDS - 100);

	board.link_up = true;
	CHECK(run(99) == 0);
	CHECK(run(1) & STUCK_DO_RESTART);
	CHECK(state.reason == STUCK_REASON_NO_CLOUD);

	/* A link that drops again and again, each time for just under the limit, does not hold it off. */
	start(0, STUCK_REASON_NONE);
	while (state.no_cloud_seconds + 60 < STUCK_NO_CLOUD_SECONDS) {
		board.link_up = true;
		CHECK(run(60) == 0);
		board.link_up = false;
		CHECK(answer_and_tick(STUCK_LINK_GONE_SECONDS - 1) == 0);
	}
	board.link_up = true;
	CHECK(run(STUCK_NO_CLOUD_SECONDS - state.no_cloud_seconds - 1) == 0);
	CHECK(run(1) & STUCK_DO_RESTART);
}

static void test_no_cloud_past_its_limit_waits_for_the_link(void)
{
	/* Held by the back-off when the link goes. There is no reason to restart for it then. */
	start(3, STUCK_REASON_NO_CLOUD);
	board.link_up = true;
	CHECK(run(2 * HOUR - 1) == 0);
	CHECK(state.no_cloud_seconds > STUCK_NO_CLOUD_SECONDS);
	board.link_up = false;
	CHECK(answering_for(STUCK_LINK_GONE_SECONDS - 1) == 0);
	CHECK(state.count == 3);

	/* Back in time to be a flap: the 2 hours went by meanwhile, and this link has had its time. */
	board.link_up = true;
	CHECK(tick_after(1) & STUCK_DO_RESTART);
	CHECK(state.reason == STUCK_REASON_NO_CLOUD);
}

/* The hotspot had no internet, and then it was gone. When it comes back it gets its full wait. */
static void test_a_link_that_was_gone_for_long_starts_no_cloud_over(void)
{
	/* One second short of the limit: this is a flap, and the time so far still counts. */
	start(0, STUCK_REASON_NONE);
	board.link_up = true;
	CHECK(run(STUCK_NO_CLOUD_SECONDS - 10) == 0);
	board.link_up = false;
	CHECK(answer_and_tick(STUCK_LINK_GONE_SECONDS - 1) == 0);
	CHECK(state.link_down_seconds == STUCK_LINK_GONE_SECONDS - 1);
	CHECK(state.no_cloud_seconds == STUCK_NO_CLOUD_SECONDS - 10);
	board.link_up = true;
	CHECK(run(9) == 0);
	CHECK(state.link_down_seconds == 0);
	CHECK(run(1) & STUCK_DO_RESTART);

	/* At the limit: a new link. */
	start(0, STUCK_REASON_NONE);
	board.link_up = true;
	CHECK(run(STUCK_NO_CLOUD_SECONDS - 10) == 0);
	board.link_up = false;
	CHECK(answer_and_tick(STUCK_LINK_GONE_SECONDS) == 0);
	CHECK(state.no_cloud_seconds == 0);
	board.link_up = true;
	CHECK(run(STUCK_NO_CLOUD_SECONDS - 1) == 0);
	CHECK(run(1) & STUCK_DO_RESTART);

	/* It is a time without a break: two drops do not add up to one long one. */
	start(0, STUCK_REASON_NONE);
	board.link_up = true;
	CHECK(run(STUCK_NO_CLOUD_SECONDS - 10) == 0);
	board.link_up = false;
	CHECK(answer_and_tick(STUCK_LINK_GONE_SECONDS - 1) == 0);
	board.link_up = true;
	CHECK(run(1) == 0);
	board.link_up = false;
	CHECK(answer_and_tick(STUCK_LINK_GONE_SECONDS - 1) == 0);
	CHECK(state.no_cloud_seconds == STUCK_NO_CLOUD_SECONDS - 9);

	/* 890 s with no internet, 2 days off, and back with internet: no restart at all. */
	start(0, STUCK_REASON_NONE);
	board.link_up = true;
	CHECK(run(890) == 0);
	board.link_up = false;
	for (uint32_t second = 0; second < 2 * DAY; second += 30) {
		CHECK(answer_and_tick(30) == 0);
	}
	board.link_up = true;
	CHECK(run(10) == 0);
	CHECK(state.count == 0);
	board.cloud_up = true;
	CHECK(run(DAY) == 0);
	CHECK(state.count == 0);
}

static void test_a_link_that_returns_is_not_restarted_for_old_time_under_a_count(void)
{
	/* 20 minutes of link with no cloud, 25 minutes gone, and back after the 30 minutes are over. */
	start(2, STUCK_REASON_NO_CLOUD);
	board.link_up = true;
	CHECK(run(20 * MINUTE) == 0);
	board.link_up = false;
	CHECK(answering_for(25 * MINUTE) == STUCK_DO_ERASE);
	CHECK(state.count == 0);
	board.link_up = true;
	CHECK(run(STUCK_NO_CLOUD_SECONDS - 1) == 0);
	CHECK(state.count == 0);
	CHECK(run(1) & STUCK_DO_RESTART);
	CHECK(state.count == 1);
}

static void test_new_settings_start_no_cloud_over(void)
{
	start(0, STUCK_REASON_NONE);
	board.link_up = true;
	CHECK(run(STUCK_NO_CLOUD_SECONDS - 1) == 0);
	stuck_settings_changed(&state);
	CHECK(state.no_cloud_seconds == 0);
	CHECK(run(STUCK_NO_CLOUD_SECONDS - 1) == 0);
	CHECK(run(1) & STUCK_DO_RESTART);

	/* They do nothing for a chip that has stopped answering. */
	start(0, STUCK_REASON_NONE);
	CHECK(run(STUCK_WIFI_SILENT_SECONDS - 1) == 0);
	stuck_settings_changed(&state);
	CHECK(state.silent_seconds == STUCK_WIFI_SILENT_SECONDS - 1);
	CHECK(run(1) & STUCK_DO_RESTART);

	/* Or for an update that has stopped moving. */
	start(0, STUCK_REASON_NONE);
	board.update = STUCK_UPDATE_WATCHED;
	CHECK(run(STUCK_UPDATE_STALL_SECONDS - 1) == 0);
	stuck_settings_changed(&state);
	CHECK(run(1) & STUCK_DO_RESTART);
}

/* ---- UPDATE_STALL ---------------------------------------------------------------- */

static void test_update_stall_at_its_limit(void)
{
	start(0, STUCK_REASON_NONE);
	board.update = STUCK_UPDATE_WATCHED;
	CHECK(run(STUCK_UPDATE_STALL_SECONDS - 1) == 0);
	CHECK(state.stall_seconds == STUCK_UPDATE_STALL_SECONDS - 1);
	CHECK(tick_after(1) == (STUCK_DO_RESTART | STUCK_DO_WRITE));
	CHECK(state.reason == STUCK_REASON_UPDATE_STALL);

	/* It is not one of the restarts that are counted. */
	CHECK(state.count == 0);

	start(0, STUCK_REASON_NONE);
	board.update = STUCK_UPDATE_WATCHED;
	CHECK(tick_after(STUCK_UPDATE_STALL_SECONDS + 1) & STUCK_DO_RESTART);
}

static void test_progress_starts_the_stall_over(void)
{
	start(0, STUCK_REASON_NONE);
	board.update = STUCK_UPDATE_WATCHED;

	/* A slow download that keeps moving goes on for as long as it takes. */
	for (int i = 0; i < 100; i++) {
		CHECK(run(STUCK_UPDATE_STALL_SECONDS - 1) == 0);
		board.update_progress++;
		CHECK(tick_after(1) == 0);
		CHECK(state.stall_seconds == 0);
	}

	CHECK(run(STUCK_UPDATE_STALL_SECONDS - 1) == 0);
	CHECK(run(1) & STUCK_DO_RESTART);
}

static void test_a_stall_only_counts_in_the_states_it_watches(void)
{
	start(0, STUCK_REASON_NONE);
	board.link_up = true;
	board.cloud_up = true;

	board.update = STUCK_UPDATE_WATCHED;
	CHECK(run(STUCK_UPDATE_STALL_SECONDS - 1) == 0);

	/* On to a state that something else watches, and back: a full wait again. */
	board.update = STUCK_UPDATE_BOUNDED;
	CHECK(run(1) == 0);
	CHECK(state.stall_seconds == 0);
	board.update = STUCK_UPDATE_WATCHED;
	CHECK(run(STUCK_UPDATE_STALL_SECONDS - 1) == 0);

	/* An offer can wait for a person for ever. */
	board.update = STUCK_UPDATE_NONE;
	CHECK(run(2 * DAY) == 0);
	CHECK(state.stall_seconds == 0);

	board.update = STUCK_UPDATE_BOUNDED;
	CHECK(run(2 * DAY) == 0);
}

static void test_a_stall_is_not_held_off_by_the_count(void)
{
	/* It takes a job under way, so it cannot go round in a loop, and it leaves the count alone. */
	for (uint8_t count = 0; count < STUCK_COUNT_MAX; count++) {
		start(count, STUCK_REASON_WIFI_SILENT);
		board.update = STUCK_UPDATE_WATCHED;
		CHECK(run(STUCK_UPDATE_STALL_SECONDS - 1) == 0);
		CHECK(tick_after(1) == (STUCK_DO_RESTART | STUCK_DO_WRITE));
		CHECK(state.count == count);
		CHECK(state.reason == STUCK_REASON_UPDATE_STALL);
	}

	/* And no record is written once the count has stopped. */
	start(STUCK_COUNT_MAX, STUCK_REASON_WIFI_SILENT);
	board.update = STUCK_UPDATE_WATCHED;
	CHECK(run(STUCK_UPDATE_STALL_SECONDS - 1) == 0);
	CHECK(tick_after(1) == STUCK_DO_RESTART);
	CHECK(state.count == STUCK_COUNT_MAX);
}

static void test_the_update_states_and_the_other_timers(void)
{
	/* An offer is no reason to hold a hung chip. */
	start(0, STUCK_REASON_NONE);
	board.update = STUCK_UPDATE_NONE;
	CHECK(run(STUCK_WIFI_SILENT_SECONDS) & STUCK_DO_RESTART);

	/* During an update they stand aside, whatever the link does, as long as it moves. */
	start(0, STUCK_REASON_NONE);
	board.update = STUCK_UPDATE_WATCHED;
	for (int i = 0; i < 100; i++) {
		board.update_progress++;
		CHECK(run(STUCK_UPDATE_STALL_SECONDS - 1) == 0);
	}
	CHECK(state.silent_seconds == 0);

	board.link_up = true;
	for (int i = 0; i < 100; i++) {
		board.update_progress++;
		CHECK(run(STUCK_UPDATE_STALL_SECONDS - 1) == 0);
	}
	CHECK(state.no_cloud_seconds == 0);

	/* Then a full wait, once the update is over. */
	board.link_up = false;
	board.update = STUCK_UPDATE_NONE;
	CHECK(run(STUCK_WIFI_SILENT_SECONDS - 1) == 0);
	CHECK(run(1) & STUCK_DO_RESTART);
}

/* ---- the Bluetooth window --------------------------------------------------------- */

static void test_a_bluetooth_window_holds_everything(void)
{
	/* Which keeps Bluetooth usable as the way to update a board whose Wi-Fi is dead. */
	start(0, STUCK_REASON_NONE);
	board.bt_window = true;
	CHECK(run(17 * MINUTE) == 0);
	board.bt_window = false;
	CHECK(run(STUCK_WIFI_SILENT_SECONDS - 1) == 0);
	CHECK(run(1) & STUCK_DO_RESTART);
}

/* ---- the back-off ----------------------------------------------------------------- */

static void test_the_steps_of_the_back_off(void)
{
	CHECK(stuck_min_uptime_seconds(0) == 0);
	CHECK(stuck_min_uptime_seconds(1) == 5 * MINUTE);
	CHECK(stuck_min_uptime_seconds(2) == 30 * MINUTE);
	CHECK(stuck_min_uptime_seconds(3) == 2 * HOUR);
	CHECK(stuck_min_uptime_seconds(4) == 6 * HOUR);
	CHECK(stuck_min_uptime_seconds(5) == 6 * HOUR);
	CHECK(stuck_min_uptime_seconds(255) == 6 * HOUR);
}

static void test_wifi_silent_waits_for_the_back_off(void)
{
	static const uint32_t waits[] = { STUCK_WIFI_SILENT_SECONDS, 5 * MINUTE, 30 * MINUTE,
					  2 * HOUR, 6 * HOUR };

	for (uint8_t count = 0; count <= STUCK_COUNT_MAX; count++) {
		start(count, count == 0 ? STUCK_REASON_NONE : STUCK_REASON_WIFI_SILENT);
		CHECK(run(waits[count] - 1) == 0);
		CHECK(state.count == count);
		CHECK(run(1) & STUCK_DO_RESTART);
		CHECK(state.count == (count < STUCK_COUNT_MAX ? count + 1 : STUCK_COUNT_MAX));
	}
}

static void test_no_cloud_waits_for_the_back_off(void)
{
	/* Below 15 minutes the timer itself is the longer wait. */
	static const uint32_t waits[] = { STUCK_NO_CLOUD_SECONDS, STUCK_NO_CLOUD_SECONDS, 30 * MINUTE,
					  2 * HOUR, 6 * HOUR };

	for (uint8_t count = 0; count <= STUCK_COUNT_MAX; count++) {
		start(count, count == 0 ? STUCK_REASON_NONE : STUCK_REASON_NO_CLOUD);
		board.link_up = true;
		CHECK(run(waits[count] - 1) == 0);
		CHECK(state.count == count);
		CHECK(run(1) & STUCK_DO_RESTART);
		CHECK(state.reason == STUCK_REASON_NO_CLOUD);
	}
}

static void test_an_answer_during_the_back_off_calls_it_off(void)
{
	start(2, STUCK_REASON_WIFI_SILENT);
	CHECK(run(25 * MINUTE) == 0);
	CHECK(state.silent_seconds > STUCK_WIFI_SILENT_SECONDS);
	CHECK(answer_and_tick(1) == 0);
	CHECK(state.silent_seconds == 0);
	CHECK(run(STUCK_WIFI_SILENT_SECONDS) == 0);
	CHECK(state.count == 2);
}

static void test_a_dead_chip_for_a_week(void)
{
	static const uint32_t expected[] = { STUCK_WIFI_SILENT_SECONDS, 5 * MINUTE, 30 * MINUTE,
					     2 * HOUR, 6 * HOUR, 6 * HOUR, 6 * HOUR };
	struct stuck_record record;
	bool have_record = false;
	uint32_t elapsed = 0;
	int restarts = 0;
	int writes = 0;

	while (elapsed < 7 * DAY) {
		uint32_t since_boot = 0;
		uint32_t actions = 0;

		start(0, STUCK_REASON_NONE);
		stuck_state_init(&state, have_record ? &record : NULL, 0);

		while (!(actions & STUCK_DO_RESTART)) {
			actions = tick_after(1);
			since_boot++;
			CHECK(!(actions & STUCK_DO_ERASE));
		}

		if ((size_t)restarts < sizeof(expected) / sizeof(expected[0])) {
			CHECK(since_boot == expected[restarts]);
		} else {
			CHECK(since_boot == 6 * HOUR);
		}

		if (actions & STUCK_DO_WRITE) {
			record = stuck_record_of(&state);
			have_record = true;
			writes++;
		}

		elapsed += since_boot;
		restarts++;
	}

	/* Up to the count's limit, and then flash is left alone. */
	CHECK(writes == STUCK_COUNT_MAX);
	CHECK(record.count == STUCK_COUNT_MAX);
	CHECK(record.reason == STUCK_REASON_WIFI_SILENT);
	/* Four in the first 2.5 hours or so, and then four a day. */
	CHECK(restarts >= 28 && restarts <= 32);
}

/* ---- when the count clears ---------------------------------------------------------- */

static void test_the_count_clears_after_30_minutes_with_an_answer(void)
{
	start(3, STUCK_REASON_WIFI_SILENT);
	for (uint32_t i = 0; i + 30 < STUCK_HEALTHY_SECONDS; i += 30) {
		CHECK(run(29) == 0);
		CHECK(answer_and_tick(1) == 0);
	}
	while (board.uptime_seconds < STUCK_HEALTHY_SECONDS - 1) {
		CHECK(tick_after(1) == 0);
	}
	CHECK(state.count == 3);
	CHECK(state.reason == STUCK_REASON_WIFI_SILENT);

	CHECK(tick_after(1) == STUCK_DO_ERASE);
	CHECK(state.count == 0);
	CHECK(state.reason == STUCK_REASON_NONE);

	/* Once. */
	CHECK(run(MINUTE) == 0);
}

static void test_the_count_clears_after_30_minutes_with_the_cloud(void)
{
	start(4, STUCK_REASON_NO_CLOUD);
	board.link_up = true;
	board.cloud_up = true;
	CHECK(run(STUCK_HEALTHY_SECONDS - 1) == 0);
	CHECK(state.count == 4);
	CHECK(tick_after(1) == STUCK_DO_ERASE);
	CHECK(state.count == 0);

	/* The connection may have gone by then, as long as that is not a problem yet. */
	start(4, STUCK_REASON_NO_CLOUD);
	board.link_up = true;
	board.cloud_up = true;
	CHECK(run(STUCK_HEALTHY_SECONDS - STUCK_NO_CLOUD_SECONDS) == 0);
	board.cloud_up = false;
	CHECK(run(STUCK_NO_CLOUD_SECONDS - 1) == 0);
	CHECK(state.count == 4);
	CHECK(state.no_cloud_seconds == STUCK_NO_CLOUD_SECONDS - 1);
	CHECK(tick_after(1) == 0);
	CHECK(state.count == 4);

	start(4, STUCK_REASON_NO_CLOUD);
	board.link_up = true;
	board.cloud_up = true;
	CHECK(run(STUCK_HEALTHY_SECONDS - STUCK_NO_CLOUD_SECONDS + 1) == 0);
	board.cloud_up = false;
	CHECK(run(STUCK_NO_CLOUD_SECONDS - 2) == 0);
	CHECK(tick_after(1) == STUCK_DO_ERASE);
}

static void test_the_count_needs_a_sign_of_life(void)
{
	/* 30 minutes with the gate closed, and nothing has answered: that shows nothing. */
	start(2, STUCK_REASON_WIFI_SILENT);
	board.trial = true;
	CHECK(run(STUCK_HEALTHY_SECONDS + HOUR) == 0);
	CHECK(state.count == 2);

	/* An answer then is enough, with the time already there. */
	CHECK(answer_and_tick(1) == STUCK_DO_ERASE);
	CHECK(state.count == 0);
}

static void test_a_count_with_no_reason_clears_too(void)
{
	start(2, STUCK_REASON_NONE);
	board.link_up = true;
	board.cloud_up = true;
	CHECK(run(STUCK_HEALTHY_SECONDS - 1) == 0);
	CHECK(state.count == 2);
	CHECK(tick_after(1) == STUCK_DO_ERASE);
	CHECK(state.count == 0);

	start(1, STUCK_REASON_NONE);
	board.link_up = true;
	board.cloud_up = true;
	CHECK(run(STUCK_HEALTHY_SECONDS) == STUCK_DO_ERASE);
	CHECK(state.count == 0);
}

static void test_nothing_to_clear_is_not_written(void)
{
	start(0, STUCK_REASON_NONE);
	board.link_up = true;
	board.cloud_up = true;
	CHECK(run(STUCK_HEALTHY_SECONDS + HOUR) == 0);
}

static void test_the_reason_of_a_stall_clears_too(void)
{
	/* The count is 0, and there is a record to remove. */
	start(0, STUCK_REASON_UPDATE_STALL);
	board.link_up = true;
	board.cloud_up = true;
	CHECK(run(STUCK_HEALTHY_SECONDS - 1) == 0);
	CHECK(state.reason == STUCK_REASON_UPDATE_STALL);
	CHECK(tick_after(1) == STUCK_DO_ERASE);
	CHECK(state.reason == STUCK_REASON_NONE);
}

static void test_a_chip_that_hangs_soon_after_boot_keeps_backing_off(void)
{
	/* It answers, so there is a proof, and then it hangs. The 30 minutes of the back-off are also
	 * the 30 minutes that would clear the count, and the restart must win.
	 */
	start(2, STUCK_REASON_WIFI_SILENT);
	CHECK(run(13) == 0);
	CHECK(answer_and_tick(1) == 0);
	CHECK(run(STUCK_HEALTHY_SECONDS - 15) == 0);
	CHECK(state.count == 2);
	CHECK(tick_after(1) == (STUCK_DO_RESTART | STUCK_DO_WRITE));
	CHECK(state.count == 3);
}

static void test_a_hotspot_with_no_internet_keeps_backing_off(void)
{
	/* The stack answered, and the link is up: all of that is true, and the board cannot get out. */
	start(2, STUCK_REASON_NO_CLOUD);
	board.link_up = true;
	CHECK(answer_and_tick(1) == 0);
	CHECK(run(STUCK_HEALTHY_SECONDS - 2) == 0);
	CHECK(state.count == 2);
	CHECK(tick_after(1) == (STUCK_DO_RESTART | STUCK_DO_WRITE));
	CHECK(state.count == 3);

	/* If the hotspot goes for a moment while it is past its limit, the count stays. */
	start(2, STUCK_REASON_NO_CLOUD);
	board.link_up = true;
	CHECK(run(STUCK_HEALTHY_SECONDS - 60) == 0);
	CHECK(answer_and_tick(1) == 0);
	board.link_up = false;
	CHECK(answering_for(STUCK_LINK_GONE_SECONDS - 1) == 0);
	CHECK(state.no_cloud_seconds >= STUCK_NO_CLOUD_SECONDS);
	CHECK(state.count == 2);

	/* And if it is gone for longer, that link has nothing more to say: the stack's answers count. */
	CHECK(answer_and_tick(1) == STUCK_DO_ERASE);
	CHECK(state.no_cloud_seconds == 0);
	CHECK(state.count == 0);
}

/* What the count did before this was fixed: it never cleared, however long the stack answered. */
static void test_the_count_clears_for_a_stack_that_answers_with_the_link_gone(void)
{
	start(2, STUCK_REASON_NO_CLOUD);
	board.link_up = true;
	CHECK(run(20 * MINUTE) == 0);
	CHECK(state.no_cloud_seconds >= STUCK_NO_CLOUD_SECONDS);
	board.link_up = false;
	while (board.uptime_seconds < STUCK_HEALTHY_SECONDS - 30) {
		CHECK(run(29) == 0);
		CHECK(answer_and_tick(1) == 0);
	}
	CHECK(state.count == 2);
	CHECK(run(29) == 0);
	CHECK(answer_and_tick(1) == STUCK_DO_ERASE);
	CHECK(state.count == 0);
}

/*
 * What the README says about flash wear. A chip that hangs 20 minutes into each boot, while
 * associated, has its count cleared before each restart. So it never backs off, and each restart
 * takes one write and one erase. The limit on writes holds only for a chip that hangs early.
 */
static void test_a_chip_that_hangs_late_clears_its_count_every_time(void)
{
	struct stuck_record record = { 0 };
	int writes = 0;
	int erases = 0;

	for (int boots = 0; boots < 20; boots++) {
		uint32_t actions = 0;

		start(0, STUCK_REASON_NONE);
		stuck_state_init(&state, boots == 0 ? NULL : &record, 0);
		board.link_up = true;
		board.cloud_up = true;
		CHECK(run(20 * MINUTE) == 0);

		/* It hangs, and the cloud goes 90 s later. The link never does. */
		CHECK(run(90) == 0);
		board.cloud_up = false;

		while (!(actions & STUCK_DO_RESTART)) {
			actions = tick_after(1);
			erases += (actions & STUCK_DO_ERASE) != 0;
		}

		CHECK(board.uptime_seconds == 20 * MINUTE + 90 + STUCK_NO_CLOUD_SECONDS);
		CHECK(state.reason == STUCK_REASON_NO_CLOUD);
		CHECK(state.count == 1);
		CHECK(actions & STUCK_DO_WRITE);
		writes++;
		record = stuck_record_of(&state);
	}

	CHECK(writes == 20);
	CHECK(erases == 19);
}

static void test_a_chip_that_hangs_just_before_the_30_minutes(void)
{
	/* Not past the limit yet: 30 minutes of working are worth a clean slate. */
	start(2, STUCK_REASON_WIFI_SILENT);
	while (board.uptime_seconds + 30 < STUCK_HEALTHY_SECONDS - STUCK_WIFI_SILENT_SECONDS) {
		CHECK(run(29) == 0);
		CHECK(answer_and_tick(1) == 0);
	}
	CHECK(run(STUCK_HEALTHY_SECONDS - STUCK_WIFI_SILENT_SECONDS - board.uptime_seconds) == 0);
	CHECK(answer_and_tick(1) == 0);
	CHECK(state.silent_seconds == 0);
	while (board.uptime_seconds < STUCK_HEALTHY_SECONDS - 1) {
		CHECK(tick_after(1) == 0);
	}
	CHECK(state.silent_seconds < STUCK_WIFI_SILENT_SECONDS);
	CHECK(tick_after(1) == STUCK_DO_ERASE);
}

static void test_the_silence_at_its_limit_keeps_the_count(void)
{
	/* Exactly at the limit, at exactly 30 minutes. */
	start(1, STUCK_REASON_WIFI_SILENT);
	CHECK(run(STUCK_HEALTHY_SECONDS - STUCK_WIFI_SILENT_SECONDS - 1) & STUCK_DO_RESTART);
	CHECK(state.count == 2);

	start(2, STUCK_REASON_WIFI_SILENT);
	board.uptime_seconds = STUCK_HEALTHY_SECONDS - STUCK_WIFI_SILENT_SECONDS;
	state.last_uptime = board.uptime_seconds;
	CHECK(answer_and_tick(0) == 0);
	CHECK(run(STUCK_WIFI_SILENT_SECONDS - 1) == 0);
	CHECK(tick_after(1) == (STUCK_DO_RESTART | STUCK_DO_WRITE));
	CHECK(state.count == 3);

	/* One second less, and it is not stuck yet. */
	start(2, STUCK_REASON_WIFI_SILENT);
	board.uptime_seconds = STUCK_HEALTHY_SECONDS - STUCK_WIFI_SILENT_SECONDS + 1;
	state.last_uptime = board.uptime_seconds;
	CHECK(answer_and_tick(0) == 0);
	CHECK(run(STUCK_WIFI_SILENT_SECONDS - 2) == 0);
	CHECK(tick_after(1) == STUCK_DO_ERASE);
}

static void test_no_cloud_at_its_limit_keeps_the_count(void)
{
	start(2, STUCK_REASON_NO_CLOUD);
	board.uptime_seconds = STUCK_HEALTHY_SECONDS - STUCK_NO_CLOUD_SECONDS;
	state.last_uptime = board.uptime_seconds;
	board.link_up = true;
	CHECK(answer_and_tick(0) == 0);
	CHECK(run(STUCK_NO_CLOUD_SECONDS - 1) == 0);
	CHECK(tick_after(1) == (STUCK_DO_RESTART | STUCK_DO_WRITE));
	CHECK(state.count == 3);

	start(2, STUCK_REASON_NO_CLOUD);
	board.uptime_seconds = STUCK_HEALTHY_SECONDS - STUCK_NO_CLOUD_SECONDS + 1;
	state.last_uptime = board.uptime_seconds;
	board.link_up = true;
	CHECK(answer_and_tick(0) == 0);
	CHECK(run(STUCK_NO_CLOUD_SECONDS - 2) == 0);
	CHECK(tick_after(1) == STUCK_DO_ERASE);
}

/* ---- saturation ------------------------------------------------------------------- */

static void test_saturation_stops_the_writes(void)
{
	start(STUCK_COUNT_MAX - 1, STUCK_REASON_WIFI_SILENT);
	CHECK(run(stuck_min_uptime_seconds(STUCK_COUNT_MAX - 1) - 1) == 0);
	CHECK(tick_after(1) == (STUCK_DO_RESTART | STUCK_DO_WRITE));
	CHECK(state.count == STUCK_COUNT_MAX);

	start(STUCK_COUNT_MAX, STUCK_REASON_WIFI_SILENT);
	CHECK(run(stuck_min_uptime_seconds(STUCK_COUNT_MAX) - 1) == 0);
	CHECK(tick_after(1) == STUCK_DO_RESTART);
	CHECK(state.count == STUCK_COUNT_MAX);
}

/* ---- the record ------------------------------------------------------------------- */

/* Whatever is in storage, a chip that says nothing gets its restart at the first limit. */
static void check_counts_as_nothing(const struct stuck_record *record)
{
	start(0, STUCK_REASON_NONE);
	stuck_state_init(&state, record, 0);
	CHECK(state.count == 0);
	CHECK(state.reason == STUCK_REASON_NONE);
	CHECK(run(STUCK_WIFI_SILENT_SECONDS - 1) == 0);
	CHECK(run(1) & STUCK_DO_RESTART);
}

static void test_a_record_that_is_missing_or_makes_no_sense(void)
{
	struct stuck_record record = { .magic = STUCK_RECORD_MAGIC, .count = 1, .reason = 1 };

	check_counts_as_nothing(NULL);

	record.magic = 0;
	check_counts_as_nothing(&record);
	record.magic = STUCK_RECORD_MAGIC ^ 1;
	check_counts_as_nothing(&record);

	record.magic = STUCK_RECORD_MAGIC;
	record.count = STUCK_COUNT_MAX + 1;
	check_counts_as_nothing(&record);
	record.count = 255;
	check_counts_as_nothing(&record);

	record.count = 1;
	record.reason = STUCK_REASON_UPDATE_STALL + 1;
	check_counts_as_nothing(&record);
	record.reason = 255;
	check_counts_as_nothing(&record);
}

static void test_a_good_record_is_taken_as_it_is(void)
{
	const struct stuck_record last = { .magic = STUCK_RECORD_MAGIC, .count = STUCK_COUNT_MAX,
					   .reason = STUCK_REASON_UPDATE_STALL };

	memset(&state, 0xff, sizeof(state));
	stuck_state_init(&state, &last, 1234);
	CHECK(state.count == STUCK_COUNT_MAX);
	CHECK(state.reason == STUCK_REASON_UPDATE_STALL);
	CHECK(state.last_uptime == 1234);
	CHECK(state.silent_seconds == 0);
	CHECK(state.no_cloud_seconds == 0);
	CHECK(state.link_down_seconds == 0);
	CHECK(state.stall_seconds == 0);
	CHECK(!state.proof);
	CHECK(!state.restarting);
	CHECK(state.wifi_answers_seen == 0);
	CHECK(state.update_progress_seen == 0);

	/* The clock starts from there, not from 0. */
	memset(&board, 0, sizeof(board));
	board.network_stored = true;
	board.provisioned = true;
	board.uptime_seconds = 1234 + 7;
	CHECK(stuck_tick(&state, &board) == 0);
	CHECK(state.silent_seconds == 7);
}

static void test_what_gets_written(void)
{
	struct stuck_record record;
	struct stuck_record blank;
	struct stuck_state back;

	start(0, STUCK_REASON_NONE);
	CHECK(run(STUCK_WIFI_SILENT_SECONDS) & STUCK_DO_WRITE);

	record = stuck_record_of(&state);
	CHECK(record.magic == STUCK_RECORD_MAGIC);
	CHECK(record.count == 1);
	CHECK(record.reason == STUCK_REASON_WIFI_SILENT);
	CHECK(record.reserved[0] == 0);
	CHECK(record.reserved[1] == 0);

	/* It comes back as it went in. */
	stuck_state_init(&back, &record, 0);
	CHECK(back.count == 1);
	CHECK(back.reason == STUCK_REASON_WIFI_SILENT);

	memset(&blank, 0, sizeof(blank));
	CHECK(blank.count == 0);
}

/* ---- a restart happens once ----------------------------------------------------------- */

static void test_a_restart_is_decided_once(void)
{
	start(0, STUCK_REASON_NONE);
	CHECK(run(STUCK_WIFI_SILENT_SECONDS) & STUCK_DO_RESTART);
	CHECK(state.restarting);

	/* A restart that does not happen at once does not get a second line, or a second count. */
	CHECK(run(DAY) == 0);
	CHECK(state.count == 1);

	/* And it does not clear the count either, whatever it sees meanwhile. */
	board.link_up = true;
	board.cloud_up = true;
	CHECK(run(DAY) == 0);
	CHECK(state.count == 1);
	CHECK(state.reason == STUCK_REASON_WIFI_SILENT);
}

/* ---- what happened ------------------------------------------------------------------ */

/*
 * The hang on firmware 1.5.0, second by second, from its log. The chip reported a join at
 * 08:17:41, the bench stored another network in the same second, the link was down by 08:17:45,
 * and from 08:17:51 the driver logged timeouts. Nothing else ever came. A person restarted it
 * after more than 3.5 minutes. The console was in use all along, and that holds nothing off.
 */
static void test_the_incident(void)
{
	const uint32_t booted = 60;

	start(0, STUCK_REASON_NONE);
	CHECK(tick_after(booted) == 0);

	/* 08:17:41: the join. */
	board.link_up = true;
	CHECK(answer_and_tick(1) == 0);

	/* The link stays up for 4 seconds. */
	CHECK(run(4) == 0);

	/* 08:17:45: gone, and nobody says anything again. */
	board.link_up = false;
	CHECK(run(STUCK_WIFI_SILENT_SECONDS - 1) == 0);
	CHECK(tick_after(1) == (STUCK_DO_RESTART | STUCK_DO_WRITE));
	CHECK(state.reason == STUCK_REASON_WIFI_SILENT);
	CHECK(state.count == 1);

	/* That is 2 minutes after the link went, at 08:19:45. A restart cleared it. */
	CHECK(board.uptime_seconds == booted + 1 + 4 + STUCK_WIFI_SILENT_SECONDS);

	/* The next boot: the wrong password is reported 14 s later, with no driver errors. */
	stuck_state_init(&state, &(struct stuck_record){ .magic = STUCK_RECORD_MAGIC, .count = 1,
							 .reason = STUCK_REASON_WIFI_SILENT }, 0);
	board.uptime_seconds = 0;
	CHECK(run(13) == 0);
	CHECK(answer_and_tick(1) == 0);

	/* The right network goes in, and it reaches the cloud. */
	CHECK(run(10) == 0);
	board.link_up = true;
	CHECK(answer_and_tick(1) == 0);
	board.cloud_up = true;
	CHECK(run(STUCK_HEALTHY_SECONDS - 26) == 0);
	CHECK(state.count == 1);
	CHECK(run(1) == STUCK_DO_ERASE);
	CHECK(state.count == 0);
}

int main(void)
{
	test_the_words_a_test_bench_looks_for();
	test_the_limits();
	test_the_gate_term_by_term();
	test_the_gate_and_the_update_state();
	test_what_never_restarts();
	test_wifi_silent_at_its_limit();
	test_the_first_answer_clears_the_silence();
	test_a_link_that_is_up_is_not_silence();
	test_a_missing_hotspot_never_restarts();
	test_no_cloud_at_its_limit();
	test_a_cloud_connection_starts_no_cloud_over();
	test_no_cloud_adds_up_over_a_link_that_flaps();
	test_no_cloud_past_its_limit_waits_for_the_link();
	test_a_link_that_was_gone_for_long_starts_no_cloud_over();
	test_a_link_that_returns_is_not_restarted_for_old_time_under_a_count();
	test_new_settings_start_no_cloud_over();
	test_update_stall_at_its_limit();
	test_progress_starts_the_stall_over();
	test_a_stall_only_counts_in_the_states_it_watches();
	test_a_stall_is_not_held_off_by_the_count();
	test_the_update_states_and_the_other_timers();
	test_a_bluetooth_window_holds_everything();
	test_the_steps_of_the_back_off();
	test_wifi_silent_waits_for_the_back_off();
	test_no_cloud_waits_for_the_back_off();
	test_an_answer_during_the_back_off_calls_it_off();
	test_a_dead_chip_for_a_week();
	test_the_count_clears_after_30_minutes_with_an_answer();
	test_the_count_clears_after_30_minutes_with_the_cloud();
	test_the_count_needs_a_sign_of_life();
	test_a_count_with_no_reason_clears_too();
	test_nothing_to_clear_is_not_written();
	test_the_reason_of_a_stall_clears_too();
	test_a_chip_that_hangs_soon_after_boot_keeps_backing_off();
	test_a_hotspot_with_no_internet_keeps_backing_off();
	test_the_count_clears_for_a_stack_that_answers_with_the_link_gone();
	test_a_chip_that_hangs_late_clears_its_count_every_time();
	test_a_chip_that_hangs_just_before_the_30_minutes();
	test_the_silence_at_its_limit_keeps_the_count();
	test_no_cloud_at_its_limit_keeps_the_count();
	test_saturation_stops_the_writes();
	test_a_record_that_is_missing_or_makes_no_sense();
	test_a_good_record_is_taken_as_it_is();
	test_what_gets_written();
	test_a_restart_is_decided_once();
	test_the_incident();

	printf("%d stuck policy checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
