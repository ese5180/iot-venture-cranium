/*
 * Restarting a board that is stuck.
 *
 * The Wi-Fi chip hung once on firmware 1.5.0: the driver logged timeouts about every 2 s, scans
 * failed, the console kept answering and the main loop kept feeding the watchdog, so nothing
 * restarted the board. A restart by hand cleared it. This is what restarts it now, and also for
 * a chip that hangs while associated, a wedge on this side of the cloud connection, and an update
 * that has stopped moving. The decisions are in stuck_policy.c. firmware/README.md says what
 * the timers are, under "When the board is stuck".
 *
 * All functions run on the main loop. A restart happens here and nowhere else: never in a
 * network management callback, and never in the middle of a console command.
 */

#ifndef STUCK_H_
#define STUCK_H_

#include <stdint.h>

/* Read what the last boot left, and say so if it restarted because it was stuck. */
void stuck_init(void);

/* Called by the main loop once a second. Does not return if the board restarts. */
void stuck_on_tick(void);

/* A network or cloud settings were just stored. See stuck_settings_changed() in stuck_policy.h. */
void stuck_on_new_settings(void);

/* How many restarts in a row it has come to: 0 on a board that is well. See STUCK_COUNT_MAX. */
uint8_t stuck_count(void);

#endif /* STUCK_H_ */
