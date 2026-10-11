/* Host build: the formatting helper the firmware uses, mapped to the C library. */
#ifndef HOST_STUB_PRINTK_H_
#define HOST_STUB_PRINTK_H_

#include <stdio.h>

#define snprintk snprintf

#endif
