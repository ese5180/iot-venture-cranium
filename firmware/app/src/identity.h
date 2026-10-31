/*
 * Device identity and the per-device connection settings.
 */

#ifndef IDENTITY_H_
#define IDENTITY_H_

#include <stdbool.h>

#define IDENTITY_ENDPOINT_MAX   128
#define IDENTITY_URL_PREFIX_MAX 160

/*
 * Where this device connects. Neither value is secret, but both are specific to one
 * cloud account, so they are provisioned per device instead of being built into the
 * image that every device runs.
 */
struct identity_settings {
	/* AWS IoT data endpoint host name. */
	char endpoint[IDENTITY_ENDPOINT_MAX];
	/*
	 * Firmware is only ever downloaded from URLs that start with this prefix, for
	 * example "https://my-bucket.s3.us-east-1.amazonaws.com/firmware/".
	 */
	char download_url_prefix[IDENTITY_URL_PREFIX_MAX];
};

/* Work out the thing name and load the stored settings. */
int identity_init(void);

/* "cranium-" followed by the SoC's factory-programmed 64-bit identifier. */
const char *identity_thing_name(void);

/* That identifier alone, in 16 hexadecimal digits. Empty if it is not available. */
const char *identity_soc_id(void);

/*
 * NULL until the device has been provisioned. The settings belong to the main loop:
 * call these three from there, because the pointer is only good until the next change.
 */
const struct identity_settings *identity_settings_get(void);
int identity_settings_set(const char *endpoint, const char *download_url_prefix);
int identity_settings_clear(void);

#endif /* IDENTITY_H_ */
