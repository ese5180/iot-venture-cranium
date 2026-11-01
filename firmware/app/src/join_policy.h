/*
 * When a join may start, with no Wi-Fi, clock or kernel in it. This module has no side effects and
 * no hardware dependencies, so it can be tested on a host. src/net.c does what it decides, from the
 * main loop's tick, so nothing waits. firmware/README.md says why it decides it.
 *
 * Two hangs of the Wi-Fi chip came right after a connect request while the link was changing: a
 * WIFI command within a second of [WIFI] connected, and one within a second of the disconnect of
 * CLEAR_WIFI. Their cause is not known. This takes away the timing that they had, and it has not
 * been shown that the hang goes with it.
 *
 * A join that is asked for goes in order. Nothing goes to the stack until the link has been quiet for
 * a while. A board that is associated, or that has a join under way, is then asked to leave, and that
 * is waited for, up to a limit. Then nothing happens until the link has been quiet again. A second
 * request while one is held is the same request: the join reads what is stored when it starts, so it
 * uses the network that was stored last.
 *
 * net_tick()'s retry is a request as well, with two differences. It starts over a join that has told
 * it nothing, and does not ask that join to leave first. And if the link comes up while it is held,
 * by the supplicant's own reconnect, nobody wants it any more and it goes away.
 */

#ifndef JOIN_POLICY_H_
#define JOIN_POLICY_H_

#include <stdbool.h>
#include <stdint.h>

/*
 * No request to connect or to disconnect this soon after the link last changed, after a request to
 * disconnect or connect, or after the result of a join. hostap's own wait for a disconnect is 5 s as
 * well (DISCONNECT_TIMEOUT_MS in supp_api.c), and it removes its networks when that wait ends.
 */
#define JOIN_QUIET_MS       5000
/* A disconnect that has not been reported by now is taken as gone: the chip may be what hangs. */
#define JOIN_LEAVE_LIMIT_MS 10000
/*
 * A join with no result yet counts as under way for this long. hostap gives up on a stored connect
 * after about 31 s, and its connect request starts with `remove_network all`, which a join in the
 * middle of authenticating should not get from nowhere.
 */
#define JOIN_FLIGHT_MS      31000
/*
 * A hold ends after this, however often the link has changed. A stack that reports a failed join
 * every few seconds would otherwise keep the right password from ever being tried.
 */
#define JOIN_HOLD_LIMIT_MS  30000

enum join_action {
	/* Nothing to do on this tick. */
	JOIN_WAIT,
	/* Ask the stack to leave the network. Leaving is under way from here on. */
	JOIN_DISCONNECT,
	/* The disconnect did not finish in time. Take the link as gone: what is asked next is a connect. */
	JOIN_GAVE_UP,
	/* Ask the stack to join what is stored. The request has ended. */
	JOIN_CONNECT,
};

/* What the Wi-Fi stack has said, as the main loop reads it. */
struct join_view {
	uint32_t now_ms;
	/* It is associated, or the link is up, which takes an association. */
	bool associated;
	/* The link has changed since this image started, or a request has gone to the stack. */
	bool changed;
	/* When the last of those was. Only uptimes are compared, so a wrap of 49 days does no harm. */
	uint32_t changed_at_ms;
	/* A join has been asked for and the stack has said nothing about it yet. Since when. */
	bool joining;
	uint32_t joining_since_ms;
};

struct join_state {
	/* Somebody asked for a join that has not started. */
	bool pending;
	/* Only net_tick()'s retry asked for it. */
	bool retry;
	/* It has been held for a quiet time, since then. */
	bool held;
	uint32_t held_since_ms;
	/* A disconnect has been asked for, and it has not finished. */
	bool leaving;
	uint32_t leaving_since_ms;
};

/* A join is wanted. If one is held already this changes nothing, and it does not start its wait over. */
void join_request(struct join_state *join);

/* The same from net_tick()'s retry. A request that is held already stays what it is. */
void join_retry(struct join_state *join);

/* No join is wanted any more: the stored network has gone. */
void join_cancel(struct join_state *join);

/* The link has come up, or got an association, by itself. A retry that is held has no point now. */
void join_link_came_up(struct join_state *join);

bool join_pending(const struct join_state *join);

/* Somebody else is asking for a disconnect. On a board that is not associated this ends at once. */
void join_leaving(struct join_state *join, uint32_t now_ms);

/* What to do now. Called on every tick and at every request. Only the main loop calls any of this. */
enum join_action join_next(struct join_state *join, const struct join_view *view);

#endif /* JOIN_POLICY_H_ */
