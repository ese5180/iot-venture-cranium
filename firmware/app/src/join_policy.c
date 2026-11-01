#include "join_policy.h"

void join_request(struct join_state *join)
{
	join->pending = true;
}

void join_cancel(struct join_state *join)
{
	join->pending = false;
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

enum join_action join_next(struct join_state *join, const struct join_view *view)
{
	if (join->leaving) {
		if (view->associated && view->now_ms - join->leaving_since_ms < JOIN_LEAVE_LIMIT_MS) {
			return JOIN_WAIT;
		}

		join->leaving = false;

		if (view->associated) {
			return JOIN_GAVE_UP;
		}
	}

	if (!join->pending) {
		return JOIN_WAIT;
	}

	if (view->associated) {
		join_leaving(join, view->now_ms);
		return JOIN_DISCONNECT;
	}

	if (view->changed && view->now_ms - view->changed_at_ms < JOIN_QUIET_MS) {
		return JOIN_WAIT;
	}

	join->pending = false;
	return JOIN_CONNECT;
}
