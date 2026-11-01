/*
 * Firmware update over Bluetooth LE, behind CONFIG_APP_BT_OTA.
 *
 * Bluetooth is off until a person holds Button 1 for five seconds and lets go. That opens a
 * window of limited time: the board advertises, a phone connects and pairs with the passkey
 * that comes out on the console, and it can upload an image to the secondary slot over
 * MCUmgr. The image is then offered, as a cloud update is: Button 1 asks the bootloader for a
 * trial swap and restarts, and Button 2 erases it. The bootloader checks the signature, and the
 * image stays on trial. See "Firmware update over Bluetooth" in firmware/README.md.
 *
 * All functions run on the main loop, unless they say otherwise.
 */

#ifndef BT_OTA_H_
#define BT_OTA_H_

#include <stdbool.h>
#include <stdint.h>

#include "bt_ota_policy.h"
#include "ui.h"

/* Called by ota_init(), which knows what the bootloader did. job_record: see ota_bt_has_job(). */
void bt_ota_on_boot(bool on_trial, bool has_trailer, bool job_record);

/*
 * A button was let go. Returns true if that was for this module, and nothing else should act
 * on it. physical: a real press of a real button, which a command on the console is not.
 */
bool bt_ota_on_button(uint8_t button, bool long_press, bool physical);

void bt_ota_on_tick(void);

/* The image on trial has been confirmed because it reached the cloud. */
void bt_ota_on_cloud_proof(void);

/* Connected to the cloud: tell it about the last update over Bluetooth. */
void bt_ota_on_cloud_up(void);

bool bt_ota_is_open(void);
enum ui_state bt_ota_ui_state(void);

#endif /* BT_OTA_H_ */
