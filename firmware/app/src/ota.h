/*
 * Firmware update manager.
 *
 * An update is an AWS IoT job. The device refuses anything that is not strictly newer
 * than what it runs and waits for a button press; until then the job stays queued in
 * the cloud and can simply be withdrawn. After the press it tells the cloud that it
 * starts, downloads the image over HTTPS into the secondary slot in external flash,
 * checks its SHA-256 and tells the cloud that it is about to install. Both
 * announcements have to be accepted before the device goes on. It then waits a
 * little, looks at the job once more, and only then asks the bootloader for a trial
 * swap and restarts, so that a job cancelled in the meantime is not installed.
 * The bootloader verifies the signature. The new image must reach the cloud again
 * before it is confirmed; otherwise the previous image comes back. The job is only
 * reported as succeeded after that confirmation.
 *
 * All functions run on the main loop.
 */

#ifndef OTA_H_
#define OTA_H_

#include <stdbool.h>
#include <stddef.h>

#include "app_events.h"
#include "cloud.h"

enum ota_state {
	OTA_IDLE,
	/* A valid update is on offer and waits for Button 1 (install) or 2 (decline). */
	OTA_AWAITING_USER,
	/* Asked the cloud for the job document again, to get a fresh download URL. */
	OTA_REFRESHING,
	/* Told the cloud that the update starts; waiting for it to agree. */
	OTA_STARTING,
	OTA_DOWNLOADING,
	OTA_VERIFYING,
	/* The image is good. Told the cloud that it gets installed; waiting for it to agree. */
	OTA_COMMITTING,
	/* The installation was accepted. After one more look at the job the image is
	 * handed to the bootloader and the device restarts.
	 */
	OTA_REBOOTING,
	/* A new image is running and has not been confirmed yet. */
	OTA_TESTING,
};

/* Work out, right after boot, what happened to an update that was in flight. */
int ota_init(void);

void ota_on_cloud_up(void);
void ota_on_job_message(enum cloud_job_message kind, const char *payload, size_t len);
void ota_on_job_ack(char kind, uint16_t sequence, bool accepted, bool permanent);
void ota_on_button(enum app_button button);
void ota_on_download(enum app_download_event what, int value);
void ota_on_tick(void);

enum ota_state ota_state(void);
const char *ota_state_name(void);

/* For the device shadow. */
const char *ota_job_id(void);
int ota_progress(void);
const char *ota_last_result(void);
const char *ota_last_error(void);

/* True once after something the shadow reports has changed. */
bool ota_take_changed(void);

#endif /* OTA_H_ */
