/* Host build: the helpers from Zephyr's util.h that the firmware uses. */
#ifndef HOST_STUB_UTIL_H_
#define HOST_STUB_UTIL_H_

#define MIN(a, b) (((a) < (b)) ? (a) : (b))
#define BIT(n) (1UL << (n))
#define ARRAY_SIZE(array) (sizeof(array) / sizeof((array)[0]))

/* True if the macro is defined as 1, as Kconfig does. */
#define Z_IS_ENABLED3(ignore, value, ...) value
#define Z_IS_ENABLED2(one_or_two_args) Z_IS_ENABLED3(one_or_two_args 1, 0)
#define Z_ENABLED_PROBE_1 _YYYY,
#define Z_IS_ENABLED1(config) Z_IS_ENABLED2(Z_ENABLED_PROBE_##config)
#define IS_ENABLED(config) Z_IS_ENABLED1(config)

#endif
