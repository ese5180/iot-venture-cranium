#include "store.h"

#include <errno.h>

#include <psa/internal_trusted_storage.h>
#include <zephyr/logging/log.h>
#include <zephyr/toolchain.h>

LOG_MODULE_REGISTER(store, CONFIG_APP_LOG_LEVEL);

/* "CRAN" in the upper half keeps these identifiers apart from any other user. */
#define STORE_UID(id) ((psa_storage_uid_t)0x4352414e00000000ULL | (psa_storage_uid_t)(id))

/*
 * Every record in store.h takes one asset in TF-M's internal trusted storage, and so does each
 * stored Wi-Fi network, which the credentials library keeps as a persistent PSA key. Certificates
 * and the device key are in protected storage, which counts its own. A write past the limit fails.
 */
BUILD_ASSERT(STORE_TEST_FAULT + CONFIG_WIFI_CREDENTIALS_MAX_ENTRIES <= CONFIG_TFM_ITS_NUM_ASSETS,
	     "more records than TF-M's internal trusted storage can hold");

int store_read(enum store_id id, void *data, size_t size)
{
	size_t read = 0;
	psa_status_t status = psa_its_get(STORE_UID(id), 0, size, data, &read);

	if (status == PSA_ERROR_DOES_NOT_EXIST) {
		return -ENOENT;
	}

	if (status != PSA_SUCCESS) {
		LOG_ERR("Reading record %d failed: %d", id, (int)status);
		return -EIO;
	}

	/* A record of another size was written by a different firmware layout. */
	return read == size ? 0 : -EBADMSG;
}

int store_write(enum store_id id, const void *data, size_t size)
{
	psa_status_t status = psa_its_set(STORE_UID(id), size, data, PSA_STORAGE_FLAG_NONE);

	if (status != PSA_SUCCESS) {
		LOG_ERR("Writing record %d failed: %d", id, (int)status);
		return -EIO;
	}

	return 0;
}

int store_erase(enum store_id id)
{
	psa_status_t status = psa_its_remove(STORE_UID(id));

	if (status != PSA_SUCCESS && status != PSA_ERROR_DOES_NOT_EXIST) {
		LOG_ERR("Erasing record %d failed: %d", id, (int)status);
		return -EIO;
	}

	return 0;
}
