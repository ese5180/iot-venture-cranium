/* Host build: the little of the input API that ui.c uses. A test calls the callback itself. */
#ifndef HOST_STUB_INPUT_H_
#define HOST_STUB_INPUT_H_

#include <stdint.h>

#define INPUT_EV_KEY 0x01
#define INPUT_EV_REL 0x02
#define INPUT_KEY_0  11
#define INPUT_KEY_1  2
#define INPUT_KEY_2  3

struct input_event {
	uint8_t type;
	uint16_t code;
	int32_t value;
};

#define INPUT_CALLBACK_DEFINE(dev, callback, data)                                           \
	void (*const host_input_callback)(struct input_event *, void *) = callback

#endif
