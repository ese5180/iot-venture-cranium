/*
 * The serial console: setting up and debugging the board from a plain serial monitor,
 * one command per line, on the J-Link's second virtual COM port (uart0).
 *
 * The console is a development and provisioning feature, behind CONFIG_APP_CONSOLE. A
 * release build turns it off, and then these functions do nothing.
 *
 * The parts:
 *   console_parser.c   reading lines and splitting them; no hardware
 *   console_cmd.c      the command table and the handlers; no hardware
 *   console_stream.c   loading a certificate in chunks; no hardware
 *   console_keys.c     creating the device key; PSA and Mbed TLS
 *   console.c          the UART, the task, transmit buffering, the log backend
 *
 * Who may touch what: the console runs as its own low-priority task. What the main loop
 * owns (the cloud settings, the update state, anything that could race with an update)
 * it reads and changes through console_port_on_main(), so that the main loop still does
 * everything one event at a time. What can never harm an update happens on the console
 * task: reading the atomics in net.c and cloud.c, the device ID and the credential stores,
 * asking the Wi-Fi stack for its status, and creating a key in TF-M. Giving up the old key
 * is not among these.
 */

#ifndef CONSOLE_H_
#define CONSOLE_H_

#include <stdint.h>

#include <zephyr/toolchain.h>

#if defined(CONFIG_APP_CONSOLE)

/* Discard pending input, print the status box and start taking commands. */
void console_start(void);

/*
 * Print "[tag] text" as one whole line, from any thread. It never waits: if the transmit
 * buffer is full, the line is dropped and counted.
 */
void console_event(const char *tag, const char *format, ...) __printf_like(2, 3);

#else

static inline void console_start(void)
{
}

static inline void __printf_like(2, 3) console_event(const char *tag, const char *format, ...)
{
	ARG_UNUSED(tag);
	ARG_UNUSED(format);
}

#endif /* CONFIG_APP_CONSOLE */

/* Why the last boot ended, as Zephyr's hwinfo RESET_ bits. */
uint32_t console_last_reset_cause(void);

#endif /* CONSOLE_H_ */
