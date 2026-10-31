/*
 * The log backend of a build without the console: it throws everything away.
 *
 * A release build has no serial output, but it keeps Zephyr's logging and its assertions,
 * and the log thread starts with an assertion that a backend exists. Without one, that thread
 * halts the board before main() has armed the watchdog. No output, no LED, no reset, and the
 * bootloader never gets to revert it.
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log_backend.h>
#include <zephyr/logging/log_msg.h>

static void discard_process(const struct log_backend *const backend, union log_msg_generic *msg)
{
	ARG_UNUSED(backend);
	ARG_UNUSED(msg);
}

static void discard_panic(const struct log_backend *const backend)
{
	ARG_UNUSED(backend);
}

static const struct log_backend_api discard_api = {
	.process = discard_process,
	.panic = discard_panic,
};

LOG_BACKEND_DEFINE(discard_log_backend, discard_api, true);
