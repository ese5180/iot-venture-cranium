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
};

/* Read a record of exactly size bytes. -ENOENT if it does not exist. */
int store_read(enum store_id id, void *data, size_t size);

/* Create or replace a record. */
int store_write(enum store_id id, const void *data, size_t size);

/* Remove a record. Removing one that does not exist is not an error. */
int store_erase(enum store_id id);

#endif /* STORE_H_ */
