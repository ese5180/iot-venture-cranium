#include "console_stream.h"

#include <errno.h>
#include <string.h>

#include <zephyr/sys/base64.h>

#define CRC16_INITIAL 0xffff

static struct {
	bool active;
	enum console_stream_kind kind;
	uint32_t total;
	uint32_t chunk_count;
	uint32_t next_index;
	uint32_t received;
	uint16_t expected_crc;
	uint16_t crc;
	int64_t last_activity;
	uint8_t data[CONSOLE_STREAM_MAX];
} stream;

uint16_t console_crc16(uint16_t crc, const uint8_t *data, size_t length)
{
	for (size_t i = 0; i < length; i++) {
		crc ^= (uint16_t)(data[i] << 8);
		for (int bit = 0; bit < 8; bit++) {
			crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
		}
	}

	return crc;
}

bool console_stream_start(uint32_t total, uint32_t chunk_count, uint16_t crc,
			  enum console_stream_kind kind, int64_t now_ms)
{
	stream.active = false;

	if (total == 0 || total > CONSOLE_STREAM_MAX || chunk_count == 0 || chunk_count > total) {
		return false;
	}

	stream.active = true;
	stream.kind = kind;
	stream.total = total;
	stream.chunk_count = chunk_count;
	stream.next_index = 0;
	stream.received = 0;
	stream.expected_crc = crc;
	stream.crc = CRC16_INITIAL;
	stream.last_activity = now_ms;
	return true;
}

static enum console_stream_result abort_with(enum console_stream_result result)
{
	stream.active = false;
	return result;
}

enum console_stream_result console_stream_chunk(uint32_t index, const char *base64, int64_t now_ms)
{
	size_t length = 0;

	if (!stream.active) {
		return CONSOLE_STREAM_NOT_ACTIVE;
	}

	if (index != stream.next_index) {
		return abort_with(CONSOLE_STREAM_WRONG_INDEX);
	}

	/* A chunk is decoded into the free part of the buffer, so too much cannot fit. */
	int err = base64_decode(stream.data + stream.received, sizeof(stream.data) - stream.received,
				&length, (const uint8_t *)base64, strlen(base64));

	if (err == -ENOMEM) {
		return abort_with(CONSOLE_STREAM_TOO_MUCH);
	}

	if (err != 0 || length == 0) {
		return abort_with(CONSOLE_STREAM_BAD_BASE64);
	}

	if (stream.received + length > stream.total) {
		return abort_with(CONSOLE_STREAM_TOO_MUCH);
	}

	stream.crc = console_crc16(stream.crc, stream.data + stream.received, length);
	stream.received += (uint32_t)length;
	stream.next_index++;
	stream.last_activity = now_ms;

	if (stream.next_index < stream.chunk_count) {
		return CONSOLE_STREAM_MORE;
	}

	if (stream.received != stream.total) {
		return abort_with(CONSOLE_STREAM_WRONG_LENGTH);
	}

	return abort_with(stream.crc == stream.expected_crc ? CONSOLE_STREAM_COMPLETE
							    : CONSOLE_STREAM_BAD_CRC);
}

const uint8_t *console_stream_data(size_t *length, enum console_stream_kind *kind)
{
	*length = stream.received;
	*kind = stream.kind;
	return stream.data;
}

void console_stream_get_status(struct console_stream_status *status)
{
	status->active = stream.active;
	status->kind = stream.kind;
	status->total = stream.total;
	status->received = stream.received;
	status->chunk_count = stream.chunk_count;
	status->next_index = stream.next_index;
}

bool console_stream_cancel(void)
{
	bool was_active = stream.active;

	stream.active = false;
	return was_active;
}

bool console_stream_expire(int64_t now_ms)
{
	if (!stream.active || now_ms - stream.last_activity < CONSOLE_STREAM_IDLE_MS) {
		return false;
	}

	stream.active = false;
	return true;
}
