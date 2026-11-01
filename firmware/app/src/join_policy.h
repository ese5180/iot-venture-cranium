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
 * A join that is asked for goes in order. A board that is associated is asked to leave first, and
 * that is waited for, up to a limit. Then nothing happens until the link has been quiet for a while.
 * A second request while one is held is the same request: the join reads what is stored when it
 * starts, so it uses the network that was stored last.
 */

#ifndef JOIN_POLICY_H_
#define JOIN_POLICY_H_

#include <stdbool.h>
#include <stdint.h>

/*
 * No connect request this soon after the link last changed, or after a request to disconnect or
 * connect. hostap's own wait for a disconnect is 5 s as well (DISCONNECT_TIMEOUT_MS in supp_api.c),
 * and it removes its networks when that wait ends.
 */
#define JOIN_QUIET_MS       5000
/* A disconnect that has not been reported by now is taken as gone: the chip may be what hangs. */
#define JOIN_LEAVE_LIMIT_MS 10000

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
};

struct join_state {
	/* Somebody asked for a join that has not started. */
	bool pending;
	/* A disconnect has been asked for, and it has not finished. */
	bool leaving;
	uint32_t leaving_since_ms;
};

/* A join is wanted. If one is held already this changes nothing, and it does not start its wait over. */
void join_request(struct join_state *join);

/* No join is wanted any more: the stored network has gone. */
void join_cancel(struct join_state *join);

bool join_pending(const struct join_state *join);

/* Somebody else is asking for a disconnect. On a board that is not associated this ends at once. */
void join_leaving(struct join_state *join, uint32_t now_ms);

/* What to do now. Called on every tick and at every request. Only the main loop calls any of this. */
enum join_action join_next(struct join_state *join, const struct join_view *view);

#endif /* JOIN_POLICY_H_ */
