/*
 * Small persistent records kept in TF-M Internal Trusted Storage.
 *
 * The records live in the secure domain's flash. The application can only reach them
 * through the PSA storage API, and they survive firmware updates because they are not
 * part of the image.
 */

#ifndef STORE_H_
#define STORE_H_

#include <stddef.h>

enum store_id {
	/* struct identity_settings: where this device connects. Not secret. */
	STORE_DEVICE_CONFIG = 1,
	/* struct ota_record: an update that was started and not yet reported. */
	STORE_OTA_RECORD = 2,
	/* The settable device ID. Not secret. See device.h. */
	STORE_DEVICE_ID = 3,
	/* First-time setup has finished. Written last, so see device.h for the order. */
	STORE_INIT_FLAG = 4,
	/* struct bt_ota_record: the last update over Bluetooth, with CONFIG_APP_BT_OTA only. */
	STORE_BT_OTA_RECORD = 5,
	/* struct stuck_record: how many restarts in a row for being stuck, and the last reason. */
	STORE_STUCK = 6,
	/* The version that a test image's fault fired on, with APP_TEST_FAULT_WIFI_DEAD only. */
	STORE_TEST_FAULT = 7,
};

/* Read a record of exactly size bytes. -ENOENT if it does not exist. */
int store_read(enum store_id id, void *data, size_t size);

/* Create or replace a record. */
int store_write(enum store_id id, const void *data, size_t size);

/* Remove a record. Removing one that does not exist is not an error. */
int store_erase(enum store_id id);

#endif /* STORE_H_ */
