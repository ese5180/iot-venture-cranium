/*
 * Firmware versions in MCUboot's format: major.minor.revision+build.
 */

#ifndef VERSION_H_
#define VERSION_H_

#include <stddef.h>
#include <stdint.h>

struct fw_version {
	uint8_t major;
	uint8_t minor;
	uint16_t revision;
	uint32_t build;
};

/* "255.255.65535+4294967295" and the terminator. */
#define FW_VERSION_STRING_MAX 25

/*
 * Parse "major.minor.revision" with an optional "+build". Anything else, including
 * leading or trailing characters and out-of-range numbers, is rejected.
 */
int fw_version_parse(const char *str, struct fw_version *out);

/* Negative, zero or positive as a is older than, equal to or newer than b. */
int fw_version_compare(const struct fw_version *a, const struct fw_version *b);

/* Always writes "major.minor.revision+build". Returns 0 or -ENOSPC. */
int fw_version_to_string(const struct fw_version *version, char *buf, size_t len);

/* Version of the running image, as set in the VERSION file at build time. */
const struct fw_version *fw_version_running(void);
const char *fw_version_running_string(void);

#endif /* VERSION_H_ */
