/*
 * Host-side tests of when a join may start. test_app.c has the same orders of events on the real
 * net.c and main.c, with a fake network stack: this is the policy alone, in every order.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "join_policy.h"

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

static struct join_state join;
static struct join_view view;

static void start(void)
{
	memset(&join, 0, sizeof(join));
	memset(&view, 0, sizeof(view));
	view.now_ms = 100000;
}

static void changed_ago(uint32_t ms)
{
	view.changed = true;
	view.changed_at_ms = view.now_ms - ms;
}

static enum join_action next(void)
{
	return join_next(&join, &view);
}

static void test_the_limits_are_what_the_task_gave(void)
{
	CHECK(JOIN_QUIET_MS == 5000);
	CHECK(JOIN_LEAVE_LIMIT_MS == 10000);
	/* The hold, the longest wait for a disconnect, and a tick: well below a retry's 30 s. */
	CHECK(JOIN_QUIET_MS + JOIN_LEAVE_LIMIT_MS < 30000);
}

static void test_nothing_asked_nothing_done(void)
{
	start();
	CHECK(!join_pending(&join));
	CHECK(next() == JOIN_WAIT);

	view.associated = true;
	CHECK(next() == JOIN_WAIT);

	changed_ago(1);
	CHECK(next() == JOIN_WAIT);
}

static void test_a_quiet_board_goes_at_once(void)
{
	/* Nothing has happened since this image started: the join at boot. */
	start();
	join_request(&join);
	CHECK(join_pending(&join));
	CHECK(next() == JOIN_CONNECT);
	CHECK(!join_pending(&join));

	/* Once. */
	CHECK(next() == JOIN_WAIT);

	/* The same in the first seconds of a boot, whatever the time of no change at all reads as. */
	start();
	view.now_ms = 2000;
	view.changed_at_ms = UINT32_MAX;
	join_request(&join);
	CHECK(next() == JOIN_CONNECT);

	start();
	view.now_ms = 2000;
	join_request(&join);
	CHECK(next() == JOIN_CONNECT);

	/* Nothing has changed for a while. */
	start();
	changed_ago(JOIN_QUIET_MS);
	join_request(&join);
	CHECK(next() == JOIN_CONNECT);
}

static void test_a_link_that_has_just_changed_holds_a_join(void)
{
	for (uint32_t ago = 0; ago < JOIN_QUIET_MS; ago += 250) {
		start();
		changed_ago(ago);
		join_request(&join);
		CHECK(next() == JOIN_WAIT);
		CHECK(join_pending(&join));
	}

	/* To the millisecond. */
	start();
	changed_ago(JOIN_QUIET_MS - 1);
	join_request(&join);
	CHECK(next() == JOIN_WAIT);
	view.now_ms += 1;
	CHECK(next() == JOIN_CONNECT);
	CHECK(next() == JOIN_WAIT);
}

static void test_each_new_change_starts_the_hold_over(void)
{
	start();
	changed_ago(0);
	join_request(&join);

	for (int i = 0; i < 5; i++) {
		view.now_ms += JOIN_QUIET_MS - 1;
		CHECK(next() == JOIN_WAIT);
		changed_ago(0);
	}

	view.now_ms += JOIN_QUIET_MS;
	CHECK(next() == JOIN_CONNECT);
}

static void test_an_associated_board_leaves_first(void)
{
	start();
	view.associated = true;
	changed_ago(60000);
	join_request(&join);

	CHECK(next() == JOIN_DISCONNECT);
	CHECK(join_pending(&join));

	/* Asked once, while it is under way. */
	view.now_ms += 100;
	CHECK(next() == JOIN_WAIT);
	join_request(&join);
	CHECK(next() == JOIN_WAIT);

	/* net.c notes the request as a change. It finished: 5 s from there, no sooner. */
	changed_ago(100);
	view.now_ms += 100;
	view.associated = false;
	changed_ago(0);
	CHECK(next() == JOIN_WAIT);
	view.now_ms += JOIN_QUIET_MS - 1;
	CHECK(next() == JOIN_WAIT);
	view.now_ms += 1;
	CHECK(next() == JOIN_CONNECT);
	CHECK(!join_pending(&join));
	CHECK(next() == JOIN_WAIT);
}

static void test_a_disconnect_that_never_reports(void)
{
	start();
	view.associated = true;
	join_request(&join);
	CHECK(next() == JOIN_DISCONNECT);
	changed_ago(0);

	/* Up to its limit nothing happens, and it is not asked for again. */
	view.now_ms += JOIN_LEAVE_LIMIT_MS - 1;
	CHECK(next() == JOIN_WAIT);

	view.now_ms += 1;
	CHECK(next() == JOIN_GAVE_UP);
	CHECK(join_pending(&join));

	/* net.c takes the link as gone. The quiet time has long been over: now it goes. */
	view.associated = false;
	CHECK(next() == JOIN_CONNECT);
	CHECK(next() == JOIN_WAIT);
}

static void test_a_stack_that_still_says_associated_after_giving_up(void)
{
	/* If it is still that way at the next request, that goes through the same steps. */
	start();
	view.associated = true;
	join_request(&join);
	CHECK(next() == JOIN_DISCONNECT);
	view.now_ms += JOIN_LEAVE_LIMIT_MS;
	CHECK(next() == JOIN_GAVE_UP);
	CHECK(next() == JOIN_DISCONNECT);
	view.now_ms += JOIN_LEAVE_LIMIT_MS;
	CHECK(next() == JOIN_GAVE_UP);
}

static void test_a_disconnect_somebody_else_asked_for(void)
{
	/* CLEAR_WIFI, and a WIFI command within a second of it: the second hang. */
	start();
	view.associated = true;
	join_leaving(&join, view.now_ms);
	changed_ago(0);
	CHECK(next() == JOIN_WAIT);

	view.now_ms += 500;
	join_request(&join);

	/* It is not asked for again. */
	CHECK(next() == JOIN_WAIT);

	/* It has finished, a second after it was asked for. */
	view.now_ms += 500;
	view.associated = false;
	changed_ago(0);
	CHECK(next() == JOIN_WAIT);
	view.now_ms += JOIN_QUIET_MS - 1;
	CHECK(next() == JOIN_WAIT);
	view.now_ms += 1;
	CHECK(next() == JOIN_CONNECT);

	/* Nobody asks for a join: the disconnect ends all the same, and leaves nothing behind. */
	start();
	view.associated = true;
	join_leaving(&join, view.now_ms);
	view.associated = false;
	CHECK(next() == JOIN_WAIT);
	CHECK(!join.leaving);

	/* Nobody asks for a join, and it never reports. */
	start();
	view.associated = true;
	join_leaving(&join, view.now_ms);
	view.now_ms += JOIN_LEAVE_LIMIT_MS;
	CHECK(next() == JOIN_GAVE_UP);
	CHECK(!join.leaving);
	view.associated = false;
	CHECK(next() == JOIN_WAIT);
}

static void test_a_link_that_comes_up_during_a_hold(void)
{
	/* The join of a network stored earlier got there first. It goes before the new one. */
	start();
	changed_ago(0);
	join_request(&join);
	CHECK(next() == JOIN_WAIT);
	view.now_ms += 1000;
	view.associated = true;
	changed_ago(0);
	CHECK(next() == JOIN_DISCONNECT);
	CHECK(join_pending(&join));
	view.associated = false;
	changed_ago(0);
	CHECK(next() == JOIN_WAIT);
	view.now_ms += JOIN_QUIET_MS;
	CHECK(next() == JOIN_CONNECT);
}

static void test_a_later_request_replaces_a_held_one(void)
{
	/* One join comes of them, and the hold is not started over by asking again. */
	start();
	changed_ago(0);
	join_request(&join);
	CHECK(next() == JOIN_WAIT);
	view.now_ms += JOIN_QUIET_MS - 1;
	join_request(&join);
	CHECK(next() == JOIN_WAIT);
	view.now_ms += 1;
	join_request(&join);
	CHECK(next() == JOIN_CONNECT);
	CHECK(next() == JOIN_WAIT);
}

static void test_a_cancelled_join_stays_quiet(void)
{
	/* The network was erased during the hold. */
	start();
	changed_ago(0);
	join_request(&join);
	join_cancel(&join);
	CHECK(!join_pending(&join));
	view.now_ms += JOIN_QUIET_MS;
	CHECK(next() == JOIN_WAIT);

	/* While leaving. The disconnect still has to end, and there is no join after it. */
	start();
	view.associated = true;
	join_request(&join);
	CHECK(next() == JOIN_DISCONNECT);
	join_cancel(&join);
	view.associated = false;
	changed_ago(0);
	CHECK(next() == JOIN_WAIT);
	view.now_ms += JOIN_QUIET_MS;
	CHECK(next() == JOIN_WAIT);

	/* It can be asked for again after that. */
	join_request(&join);
	CHECK(next() == JOIN_CONNECT);
}

static void test_the_clock_can_wrap(void)
{
	/* An uptime in ms does not fit 32 bits after 49 days. */
	start();
	view.now_ms = UINT32_MAX - 1000;
	changed_ago(0);
	join_request(&join);
	view.now_ms += JOIN_QUIET_MS - 1;
	CHECK(next() == JOIN_WAIT);
	view.now_ms += 1;
	CHECK(next() == JOIN_CONNECT);

	start();
	view.now_ms = UINT32_MAX - 1000;
	view.associated = true;
	join_request(&join);
	CHECK(next() == JOIN_DISCONNECT);
	view.now_ms += JOIN_LEAVE_LIMIT_MS - 1;
	CHECK(next() == JOIN_WAIT);
	view.now_ms += 1;
	CHECK(next() == JOIN_GAVE_UP);
}

int main(void)
{
	test_the_limits_are_what_the_task_gave();
	test_nothing_asked_nothing_done();
	test_a_quiet_board_goes_at_once();
	test_a_link_that_has_just_changed_holds_a_join();
	test_each_new_change_starts_the_hold_over();
	test_an_associated_board_leaves_first();
	test_a_disconnect_that_never_reports();
	test_a_stack_that_still_says_associated_after_giving_up();
	test_a_disconnect_somebody_else_asked_for();
	test_a_link_that_comes_up_during_a_hold();
	test_a_later_request_replaces_a_held_one();
	test_a_cancelled_join_stays_quiet();
	test_the_clock_can_wrap();

	printf("%d join policy checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
