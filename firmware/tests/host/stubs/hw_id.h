/* Host build: the SoC identifier, faked by the tests. */
#ifndef HOST_STUB_HW_ID_H_
#define HOST_STUB_HW_ID_H_

#include <stddef.h>

#define HW_ID_LEN (16 + 1)

int hw_id_get(char *buf, size_t buf_len);

#endif
