/* Host build: the little of the GPIO API that ui.c uses. The pin goes nowhere. */
#ifndef HOST_STUB_GPIO_H_
#define HOST_STUB_GPIO_H_

#include <stdbool.h>

struct gpio_dt_spec {
	int pin;
};

#define DT_ALIAS(alias)                 0
#define GPIO_DT_SPEC_GET(node, prop)    { node }
#define GPIO_OUTPUT_INACTIVE            0

static inline bool gpio_is_ready_dt(const struct gpio_dt_spec *spec)
{
	(void)spec;
	return true;
}

static inline int gpio_pin_configure_dt(const struct gpio_dt_spec *spec, int flags)
{
	(void)spec;
	(void)flags;
	return 0;
}

static inline int gpio_pin_set_dt(const struct gpio_dt_spec *spec, int value)
{
	(void)spec;
	(void)value;
	return 0;
}

#endif
