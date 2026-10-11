#include "identity.h"

#include <ctype.h>
#include <errno.h>
#include <string.h>

#include <hw_id.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "store.h"

LOG_MODULE_REGISTER(identity, CONFIG_APP_LOG_LEVEL);

#define CONFIG_RECORD_VERSION 1

struct config_record {
	uint8_t version;
	struct identity_settings config;
};

static char thing_name[sizeof(CONFIG_APP_THING_NAME_PREFIX) + HW_ID_LEN];
static struct config_record record;
static bool provisioned;

/* Host names are letters, digits, dots and hyphens; nothing else is accepted. */
static bool valid_host_name(const char *host)
{
	size_t length = strlen(host);

	if (length == 0 || length >= IDENTITY_ENDPOINT_MAX || host[0] == '.' || host[0] == '-') {
		return false;
	}

	for (size_t i = 0; i < length; i++) {
		if (!isalnum((unsigned char)host[i]) && host[i] != '.' && host[i] != '-') {
			return false;
		}
	}

	return strchr(host, '.') != NULL;
}

static bool valid_url_prefix(const char *prefix)
{
	static const char scheme[] = "https://";
	size_t length = strlen(prefix);
	const char *host_end;

	if (length >= IDENTITY_URL_PREFIX_MAX || strncmp(prefix, scheme, strlen(scheme)) != 0) {
		return false;
	}

	/* The prefix must cover a complete host name, so that it cannot be extended into
	 * another host (https://bucket.example.com.attacker.net/).
	 */
	host_end = strchr(prefix + strlen(scheme), '/');
	if (host_end == NULL || host_end == prefix + strlen(scheme)) {
		return false;
	}

	for (size_t i = 0; i < length; i++) {
		if (!isgraph((unsigned char)prefix[i])) {
			return false;
		}
	}

	return true;
}

int identity_init(void)
{
	char hardware_id[HW_ID_LEN];
	int err;

	err = hw_id_get(hardware_id, sizeof(hardware_id));
	if (err) {
		LOG_ERR("Hardware identifier is not available: %d", err);
		return err;
	}

	for (char *c = hardware_id; *c != '\0'; c++) {
		*c = (char)tolower((unsigned char)*c);
	}

	(void)snprintk(thing_name, sizeof(thing_name), "%s%s", CONFIG_APP_THING_NAME_PREFIX,
		       hardware_id);

	err = store_read(STORE_DEVICE_CONFIG, &record, sizeof(record));
	provisioned = (err == 0) && record.version == CONFIG_RECORD_VERSION &&
		      valid_host_name(record.config.endpoint) &&
		      valid_url_prefix(record.config.download_url_prefix);

	if (!provisioned) {
		memset(&record, 0, sizeof(record));
	}

	return 0;
}

const char *identity_thing_name(void)
{
	return thing_name;
}

const struct identity_settings *identity_settings_get(void)
{
	return provisioned ? &record.config : NULL;
}

int identity_settings_set(const char *endpoint, const char *download_url_prefix)
{
	struct config_record candidate = { .version = CONFIG_RECORD_VERSION };
	int err;

	if (endpoint == NULL || download_url_prefix == NULL || !valid_host_name(endpoint) ||
	    !valid_url_prefix(download_url_prefix)) {
		return -EINVAL;
	}

	strncpy(candidate.config.endpoint, endpoint, sizeof(candidate.config.endpoint) - 1);
	strncpy(candidate.config.download_url_prefix, download_url_prefix,
		sizeof(candidate.config.download_url_prefix) - 1);

	err = store_write(STORE_DEVICE_CONFIG, &candidate, sizeof(candidate));
	if (err) {
		return err;
	}

	record = candidate;
	provisioned = true;
	return 0;
}

int identity_settings_clear(void)
{
	provisioned = false;
	memset(&record, 0, sizeof(record));
	return store_erase(STORE_DEVICE_CONFIG);
}
