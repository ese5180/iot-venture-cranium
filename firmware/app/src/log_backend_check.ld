/*
 * Without a log backend the board halts as soon as the log thread runs: see log_discard.c.
 * That cannot be seen in a build, or on a board with no output, so the link stops here.
 */
ASSERT(_log_backend_list_end > _log_backend_list_start, "this image has no log backend, and it would halt at boot")
