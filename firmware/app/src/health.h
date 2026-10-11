/*
 * Watchdog and the trial period of a newly installed image.
 */

#ifndef HEALTH_H_
#define HEALTH_H_

#include <stdbool.h>

/* Start the hardware watchdog. From here on health_feed() must be called regularly. */
int health_init(void);

/* Called by the main loop once a second. */
void health_feed(void);

/*
 * A new image is running on trial. If health_trial_passed() is not called within the
 * configured time, the device resets and the bootloader restores the previous image.
 */
void health_trial_begin(void);
void health_trial_passed(void);
bool health_trial_active(void);

#endif /* HEALTH_H_ */
