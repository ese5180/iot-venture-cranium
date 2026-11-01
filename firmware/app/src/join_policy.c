#include "join_policy.h"

void join_request(struct join_state *join)
{
	join->pending = true;
	join->retry = false;
}

void join_retry(struct join_state *join)
{
	if (!join->pending) {
		join->pending = true;
		join->retry = true;
	}
}

void join_cancel(struct join_state *join)
{
	join->pending = false;
	join->held = false;
}

void join_link_came_up(struct join_state *join)
{
	if (join->retry) {
		join_cancel(join);
	}
}

bool join_pending(const struct join_state *join)
{
	return join->pending;
}

void join_leaving(struct join_state *join, uint32_t now_ms)
{
	join->leaving = true;
	join->leaving_since_ms = now_ms;
}

/* Too soon after a change to ask the stack for anything, and this request has not waited too long. */
static bool hold(struct join_state *join, const struct join_view *view)
{
	if (!view->changed || view->now_ms - view->changed_at_ms >= JOIN_QUIET_MS) {
		return false;
	}

	if (!join->held) {
		join->held = true;
		join->held_since_ms = view->now_ms;
	}

	return view->now_ms - join->held_since_ms < JOIN_HOLD_LIMIT_MS;
}

enum join_action join_next(struct join_state *join, const struct join_view *view)
{
	const bool joining = view->joining && view->now_ms - view->joining_since_ms < JOIN_FLIGHT_MS;

	if (join->leaving) {
		if ((view->associated || joining) &&
		    view->now_ms - join->leaving_since_ms < JOIN_LEAVE_LIMIT_MS) {
			return JOIN_WAIT;
		}

		join->leaving = false;

		if (view->associated || joining) {
			return JOIN_GAVE_UP;
		}
	}

	if (!join->pending || hold(join, view)) {
		return JOIN_WAIT;
	}

	if (view->associated || (joining && !join->retry)) {
		join_leaving(join, view->now_ms);
		return JOIN_DISCONNECT;
	}

	join_cancel(join);
	return JOIN_CONNECT;
}
