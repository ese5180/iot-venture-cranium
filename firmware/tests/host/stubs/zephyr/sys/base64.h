/* Host build: the prototypes of the firmware's base64 library, built from its own source. */
#ifndef HOST_STUB_BASE64_H_
#define HOST_STUB_BASE64_H_

#include <stddef.h>
#include <stdint.h>

int base64_encode(uint8_t *dst, size_t dlen, size_t *olen, const uint8_t *src, size_t slen);
int base64_decode(uint8_t *dst, size_t dlen, size_t *olen, const uint8_t *src, size_t slen);

#endif
