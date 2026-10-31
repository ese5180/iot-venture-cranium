/* Host build: the toolchain helpers the firmware uses. */
#ifndef HOST_STUB_TOOLCHAIN_H_
#define HOST_STUB_TOOLCHAIN_H_

#define ARG_UNUSED(x)         (void)(x)
#define __printf_like(f, a)   __attribute__((format(printf, f, a)))
#define BUILD_ASSERT(cond, ...) _Static_assert(cond, "" __VA_ARGS__)

#endif
