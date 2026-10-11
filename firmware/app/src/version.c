#include "version.h"

#include <errno.h>
#include <limits.h>
#include <stdbool.h>

#include <zephyr/sys/printk.h>

#if defined(CONFIG_APP_VERSION_FROM_BUILD)
#include <app_version.h>
#define RUNNING_MAJOR    APP_VERSION_MAJOR
#define RUNNING_MINOR    APP_VERSION_MINOR
#define RUNNING_REVISION APP_PATCHLEVEL
#define RUNNING_BUILD    APP_TWEAK
#else
/* Host-side unit tests have no VERSION file. */
#define RUNNING_MAJOR    0
#define RUNNING_MINOR    0
#define RUNNING_REVISION 0
#define RUNNING_BUILD    0
#endif

static const struct fw_version running = {
	.major = RUNNING_MAJOR,
	.minor = RUNNING_MINOR,
	.revision = RUNNING_REVISION,
	.build = RUNNING_BUILD,
};

/*
 * Read an unsigned decimal number of at most ten digits that is not larger than
 * limit. Leading zeros are accepted only for the value zero itself, so that every
 * version has exactly one spelling.
 */
static int parse_number(const char **cursor, uint32_t limit, uint32_t *out)
{
	const char *p = *cursor;
	uint64_t value = 0;
	int digits = 0;

	while (*p >= '0' && *p <= '9') {
		value = value * 10 + (uint64_t)(*p - '0');
		digits++;
		p++;
		if (digits > 10 || value > limit) {
			return -ERANGE;
		}
	}

	if (digits == 0) {
		return -EINVAL;
	}

	if (digits > 1 && **cursor == '0') {
		return -EINVAL;
	}

	*out = (uint32_t)value;
	*cursor = p;
	return 0;
}

int fw_version_parse(const char *str, struct fw_version *out)
{
	uint32_t major, minor, revision, build = 0;
	const char *p = str;

	if (str == NULL || out == NULL) {
		return -EINVAL;
	}

	if (parse_number(&p, UINT8_MAX, &major) != 0 || *p++ != '.') {
		return -EINVAL;
	}

	if (parse_number(&p, UINT8_MAX, &minor) != 0 || *p++ != '.') {
		return -EINVAL;
	}

	if (parse_number(&p, UINT16_MAX, &revision) != 0) {
		return -EINVAL;
	}

	if (*p == '+') {
		p++;
		if (parse_number(&p, UINT32_MAX, &build) != 0) {
			return -EINVAL;
		}
	}

	if (*p != '\0') {
		return -EINVAL;
	}

	out->major = (uint8_t)major;
	out->minor = (uint8_t)minor;
	out->revision = (uint16_t)revision;
	out->build = build;
	return 0;
}

int fw_version_compare(const struct fw_version *a, const struct fw_version *b)
{
	if (a->major != b->major) {
		return a->major < b->major ? -1 : 1;
	}

	if (a->minor != b->minor) {
		return a->minor < b->minor ? -1 : 1;
	}

	if (a->revision != b->revision) {
		return a->revision < b->revision ? -1 : 1;
	}

	if (a->build != b->build) {
		return a->build < b->build ? -1 : 1;
	}

	return 0;
}

int fw_version_to_string(const struct fw_version *version, char *buf, size_t len)
{
	int written = snprintk(buf, len, "%u.%u.%u+%u", version->major, version->minor,
			       version->revision, version->build);

	return (written < 0 || (size_t)written >= len) ? -ENOSPC : 0;
}

const struct fw_version *fw_version_running(void)
{
	return &running;
}

const char *fw_version_running_string(void)
{
	static char text[FW_VERSION_STRING_MAX];

	if (text[0] == '\0') {
		(void)fw_version_to_string(&running, text, sizeof(text));
	}

	return text;
}
