#!/usr/bin/env python3
"""Tests of tools/recover.py against a stand-in for MCUboot's serial recovery. No board.

    python3 firmware/tests/hil/test_recover.py

Run from an nRF Connect SDK terminal, which provides pyserial and cbor2. The stand-in
speaks the same framing as the bootloader and can misbehave the way a real link does:
answer late, or lose an answer.
"""

import base64
import contextlib
import io
import struct
import time
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "tools"))

import cbor2  # noqa: E402
import recover  # noqa: E402
from board import BoardError  # noqa: E402

# CONFIG_BOOT_MAX_LINE_INPUT_LEN in the bootloader's build.
MAX_LINE = 128


def frame(op, group, sequence, command, body):
    """A reply as the bootloader sends it."""
    payload = cbor2.dumps(body)
    packet = struct.pack(">BBHHBB", op + 1, 0, len(payload), group, sequence, command) + payload
    packet += struct.pack(">H", recover.crc16(packet))
    framed = struct.pack(">H", len(packet)) + packet
    return b"\x06\x09" + base64.b64encode(framed) + b"\n"


class FakeBootloader:
    """Takes the place of the serial port in recover.Link."""

    def __init__(self):
        self.pending = b""
        self.reply = b""
        self.lines = []
        self.image = bytearray()
        self.requests = []
        self.lose = set()
        self.late_echoes = 0
        self.fail_upload_with = 0
        self.say_offset = None
        self.images = []

    def write(self, data):
        self.lines.append(data)
        self.pending += data
        while b"\n" in self.pending:
            line, self.pending = self.pending.split(b"\n", 1)
            if line[:2] == b"\x06\x09":
                self.message = base64.b64decode(line[2:])
            else:
                self.message += base64.b64decode(line[2:])
            if len(self.message) - 2 >= struct.unpack(">H", self.message[:2])[0]:
                self.handle(self.message[2:])

    def handle(self, packet):
        assert recover.crc16(packet) == 0, "bad checksum in a request"
        op, _, _, group, sequence, command = struct.unpack(">BBHHBB", packet[:8])
        body = cbor2.loads(packet[8:-2])
        self.requests.append((group, command, body))
        answer = {"rc": 0}
        if (group, command) == (recover.GROUP_OS, recover.ID_OS_ECHO):
            answer = {"r": body["d"]}
            # Answers to greetings before this one that are only arriving now.
            for earlier in range(1, self.late_echoes + 1):
                self.reply += frame(op, group, (sequence - earlier) & 0xff, command, {"r": "late"})
        elif (group, command) == (recover.GROUP_IMAGE, recover.ID_IMAGE_STATE):
            answer = {"images": self.images}
        elif (group, command) == (recover.GROUP_IMAGE, recover.ID_IMAGE_UPLOAD):
            if self.fail_upload_with:
                answer = {"rc": self.fail_upload_with}
            else:
                if body["off"] == len(self.image):
                    self.image += body["data"]
                answer = {"rc": 0, "off": len(self.image) if self.say_offset is None else self.say_offset}
        number = len(self.requests)
        if number not in self.lose:
            self.reply += frame(op, group, sequence, command, answer)

    def read(self, size):
        data, self.reply = self.reply[:size], self.reply[size:]
        return data

    def reset_input_buffer(self):
        self.reply = b""

    def close(self):
        pass


class FakeBoardRunningTheApplication(FakeBootloader):
    """The application until it gets ENTER_BOOTLOADER, and the bootloader after that."""

    def __init__(self, boot_after_writes=3):
        super().__init__()
        self.received = b""
        self.running_application = True
        self.boot_after_writes = boot_after_writes

    def write(self, data):
        if not self.running_application:
            super().write(data)
            return
        self.received += data
        if b"ENTER_BOOTLOADER\r" in self.received:
            # It restarts a moment later. What arrives until then goes to the application.
            self.boot_after_writes -= 1
            if self.boot_after_writes <= 0:
                self.running_application = False
                self.pending = b""
                self.reply = b""

    def read(self, size):
        if self.running_application:
            return b"ERR line discarded, it held a control character\r\n"
        return super().read(size)


def link_to(fake):
    link = recover.Link.__new__(recover.Link)
    link.serial = fake
    link.sequence = 0
    link.received = b""
    return link


class RecoverTest(unittest.TestCase):
    def setUp(self):
        self.timeout = recover.REPLY_TIMEOUT
        recover.REPLY_TIMEOUT = 0.05

    def tearDown(self):
        recover.REPLY_TIMEOUT = self.timeout

    def test_an_image_arrives_whole(self):
        fake = FakeBootloader()
        image = bytes(range(256)) * 40
        recover.upload(link_to(fake), image)
        self.assertEqual(bytes(fake.image), image)

    def test_only_the_first_chunk_announces_the_length(self):
        fake = FakeBootloader()
        image = bytes(1000)
        recover.upload(link_to(fake), image)
        uploads = [body for group, _, body in fake.requests if group == recover.GROUP_IMAGE]
        self.assertEqual(uploads[0]["len"], len(image))
        self.assertTrue(all("len" not in body for body in uploads[1:]))

    def test_no_line_is_too_long_for_the_bootloader(self):
        fake = FakeBootloader()
        recover.upload(link_to(fake), bytes(4000))
        self.assertLessEqual(max(len(line) for line in fake.lines), MAX_LINE - 1)

    def test_a_late_answer_is_not_taken_for_the_answer_to_this_request(self):
        # The bug this guards against: the answer to a greeting was taken for the answer
        # to the first chunk, so the next chunk went out while the bootloader was still
        # writing, and it ran out of line buffers.
        fake = FakeBootloader()
        link = link_to(fake)
        fake.late_echoes = 3
        link.send(recover.OP_WRITE, recover.GROUP_OS, recover.ID_OS_ECHO, {"d": "cranium"})
        self.assertEqual(link.receive(0.05), {"r": "cranium"})

    def test_entering_forgets_the_greetings_still_on_their_way(self):
        fake = FakeBootloader()
        fake.late_echoes = 2
        link = link_to(fake)
        recover.enter(link, None)
        self.assertEqual(fake.reply, b"")
        self.assertEqual(link.received, b"")

    def test_the_running_application_is_asked_to_enter_the_bootloader(self):
        fake = FakeBoardRunningTheApplication()
        link = link_to(fake)
        recover.enter(link, None, through_console=True)
        self.assertTrue(fake.received.startswith(recover.ENTER_BOOTLOADER))
        self.assertFalse(fake.running_application)
        # The bootloader's reply is what ended the wait.
        self.assertEqual(fake.requests[-1][0:2], (recover.GROUP_OS, recover.ID_OS_ECHO))

    def test_an_image_goes_through_after_entering_by_console(self):
        fake = FakeBoardRunningTheApplication()
        link = link_to(fake)
        image = bytes(range(256)) * 4
        recover.enter(link, None, through_console=True)
        recover.upload(link, image)
        self.assertEqual(bytes(fake.image), image)

    def test_the_console_is_not_asked_unless_requested(self):
        fake = FakeBoardRunningTheApplication()
        fake.running_application = False
        link = link_to(fake)
        recover.enter(link, None)
        self.assertEqual(fake.received, b"")

    def test_a_board_that_never_restarts_is_reported(self):
        fake = FakeBoardRunningTheApplication(boot_after_writes=10**9)
        link = link_to(fake)
        now = [0.0]

        def clock():
            now[0] += 1.0
            return now[0]

        real_time = recover.time.time
        recover.time.time = clock
        try:
            with self.assertRaisesRegex(BoardError, "not listening"):
                recover.enter(link, None, through_console=True)
        finally:
            recover.time.time = real_time

    def test_a_lost_answer_is_asked_for_again(self):
        fake = FakeBootloader()
        fake.lose = {2}
        image = bytes(range(256)) * 5
        recover.upload(link_to(fake), image)
        self.assertEqual(bytes(fake.image), image)

    def test_too_many_lost_answers_stop_the_upload(self):
        fake = FakeBootloader()
        fake.lose = set(range(1, 100))
        with self.assertRaises(recover.NoAnswer):
            recover.upload(link_to(fake), bytes(1000))
        self.assertEqual(len(fake.requests), recover.MAX_LOST + 1)

    def test_the_bootloader_says_where_to_go_on(self):
        fake = FakeBootloader()
        fake.say_offset = 2000
        recover.upload(link_to(fake), bytes(2000))
        self.assertEqual(len(fake.requests), 1)

    def test_an_error_from_the_bootloader_stops_the_upload(self):
        fake = FakeBootloader()
        fake.fail_upload_with = 3
        with self.assertRaisesRegex(BoardError, "error 3"):
            recover.upload(link_to(fake), bytes(1000))

    def test_show_returns_what_the_bootloader_lists(self):
        fake = FakeBootloader()
        fake.images = [{"slot": 0, "version": "1.4.1", "hash": bytes(range(32))},
                       {"slot": 1, "version": "1.5.0"}]
        self.assertEqual(recover.show(link_to(fake)), [
            {"slot": 0, "version": "1.4.1", "hash": bytes(range(32)).hex()},
            {"slot": 1, "version": "1.5.0", "hash": None}])

    def test_show_returns_nothing_when_no_image_is_valid(self):
        self.assertEqual(recover.show(link_to(FakeBootloader())), [])

    def test_printing_the_images_is_a_separate_step(self):
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            recover.print_images([{"slot": 0, "version": "1.4.1", "hash": "ab"},
                                  {"slot": 1, "version": "1.5.0", "hash": None}])
        self.assertEqual(printed.getvalue(),
                         "slot 0: version 1.4.1, hash ab\nslot 1: version 1.5.0\n")

    def waited(self, **arguments):
        """How long enter() kept trying with a board that never answers, by its own clock."""
        fake = FakeBoardRunningTheApplication(boot_after_writes=10**9)
        fake.read = lambda size: b""
        now = [0.0]

        def clock():
            now[0] += 0.5
            return now[0]

        real_time = recover.time.time
        real_popen = recover.subprocess.Popen
        recover.time.time = clock
        recover.subprocess.Popen = mock.Mock(return_value=mock.Mock(poll=mock.Mock(return_value=0)))
        try:
            with self.assertRaisesRegex(BoardError, "not listening"):
                recover.enter(link_to(fake), arguments.pop("serial_number", None), **arguments)
        finally:
            recover.time.time = real_time
            recover.subprocess.Popen = real_popen
        return now[0]

    def test_a_board_may_take_longer_when_asked_to_wait(self):
        self.assertLess(self.waited(through_console=True), recover.ENTER_AFTER_RESTART + 5)
        self.assertLess(self.waited(serial_number="1"), recover.ENTER_AFTER_RESTART + 5)
        self.assertLess(self.waited(), recover.ENTER_ALREADY_LISTENING + 5)
        self.assertGreater(self.waited(through_console=True, deadline_seconds=recover.ENTER_THROUGH_A_SWAP),
                           recover.ENTER_THROUGH_A_SWAP)
        # Longer than the slowest swap that was measured.
        self.assertGreater(recover.ENTER_THROUGH_A_SWAP, 81)

    def restarts(self, fake, poll=None, settle=0.02):
        """How many restarts enter() asks for through the debug port, on this board."""
        calls = []

        def popen(arguments, **_):
            calls.append(arguments)
            if len(calls) == fake.listens_at_restart:
                fake.running_application = False
            return mock.Mock(poll=mock.Mock(side_effect=poll) if poll else mock.Mock(return_value=0))

        with mock.patch.object(recover.subprocess, "Popen", popen), \
                mock.patch.object(recover, "GREETING_EVERY", 0.01), \
                mock.patch.object(recover, "RESTART_SETTLE", settle), \
                contextlib.redirect_stdout(io.StringIO()):
            recover.enter(link_to(fake), "1", deadline_seconds=fake.seconds)
        self.assertTrue(all("RESET_PIN" in call for call in calls))
        return len(calls)

    def a_board(self, listens_at_restart, seconds=1.0):
        fake = FakeBoardRunningTheApplication(boot_after_writes=10**9)
        fake.listens_at_restart = listens_at_restart
        fake.seconds = seconds
        return fake

    def test_a_restart_that_goes_past_the_bootloader_is_tried_again(self):
        self.assertEqual(self.restarts(self.a_board(listens_at_restart=2)), 2)

    def test_a_board_that_listens_the_first_time_is_restarted_once(self):
        self.assertEqual(self.restarts(self.a_board(listens_at_restart=1)), 1)

    def test_it_gives_up_restarting_after_a_few_tries(self):
        fake = self.a_board(listens_at_restart=10**9)
        with self.assertRaisesRegex(BoardError, "not listening"):
            self.restarts(fake)
        fake = self.a_board(listens_at_restart=recover.ENTER_RESTARTS + 1)
        self.assertEqual(self.restarts(fake), recover.ENTER_RESTARTS + 1)

    def test_what_the_application_says_before_the_restart_does_not_count(self):
        fake = self.a_board(listens_at_restart=10**9)
        # nrfutil is still at it for a while, then the bootloader listens, and it has said nothing new.
        answers = iter([None] * 5)

        def poll():
            answer = next(answers, 0)
            if answer == 0:
                fake.running_application = False
            return answer

        self.assertEqual(self.restarts(fake, poll), 1)

    def test_an_answer_from_before_the_restart_landed_does_not_count(self):
        # The bootloader is listening when the restart is asked for, answers, and then the restart
        # lands and the application runs: nothing is listening any more.
        fake = self.a_board(listens_at_restart=10**9, seconds=0.5)
        fake.running_application = False
        answers = iter([None] * 3)

        def poll():
            answer = next(answers, 0)
            if answer == 0:
                fake.running_application = True
            return answer

        with self.assertRaisesRegex(BoardError, "not listening"):
            self.restarts(fake, poll)

    def test_an_answer_that_was_on_its_way_when_the_restart_landed_does_not_count(self):
        fake = self.a_board(listens_at_restart=10**9, seconds=0.5)
        fake.running_application = False
        # The first answer arrives in the same moment as the end of the restart.
        started = []
        real_read = fake.read

        def read(size):
            started.append(1)
            if len(started) > 1:
                fake.running_application = True
            return real_read(size)

        fake.read = read
        with self.assertRaisesRegex(BoardError, "not listening"):
            self.restarts(fake, settle=0.1)

    def test_what_arrives_right_after_a_restart_is_old_and_is_no_reason_to_restart(self):
        fake = self.a_board(listens_at_restart=10**9)
        real_read = fake.read
        began = time.time()

        def read(size):
            age = time.time() - began
            if age < 0.1:
                return b"the end of a line from before the restart\r\n"
            # The bootloader says nothing on this port until it is done checking the image.
            if age < 0.35:
                return b""
            fake.running_application = False
            return real_read(size)

        fake.read = read
        self.assertEqual(self.restarts(fake, settle=0.2), 1)

    def test_the_wait_starts_again_with_each_restart(self):
        # The second restart has an answer on its way as well, and then the application is there.
        fake = self.a_board(listens_at_restart=2, seconds=0.8)
        real_read = fake.read
        first_answer = []

        def read(size):
            if not fake.running_application:
                first_answer.append(time.time())
                if time.time() - first_answer[0] > 0.03:
                    fake.running_application = True
            return real_read(size)

        fake.read = read
        with self.assertRaisesRegex(BoardError, "not listening"):
            self.restarts(fake, settle=0.2)

    def test_a_silent_board_is_left_alone_as_it_may_be_in_a_swap(self):
        calls = []
        fake = self.a_board(listens_at_restart=10**9, seconds=0.3)
        fake.read = lambda size: b""
        with mock.patch.object(recover.subprocess, "Popen",
                               lambda arguments, **_: calls.append(arguments) or mock.Mock(poll=lambda: 0)), \
                mock.patch.object(recover, "GREETING_EVERY", 0.01), \
                self.assertRaisesRegex(BoardError, "not listening"):
            recover.enter(link_to(fake), "1", deadline_seconds=fake.seconds)
        self.assertEqual(len(calls), 1)

    def test_a_restart_that_fails_is_reported_at_once_with_what_nrfutil_said(self):
        fake = self.a_board(listens_at_restart=10**9, seconds=30.0)
        fake.read = lambda size: b""
        failed = mock.Mock(poll=mock.Mock(return_value=1), stderr=io.StringIO("no such probe\n"))
        with mock.patch.object(recover.subprocess, "Popen", return_value=failed), \
                mock.patch.object(recover, "GREETING_EVERY", 0.01), \
                self.assertRaisesRegex(BoardError, r"(?s)probe 9.*no such probe.*--serial-number") as caught:
            recover.enter(link_to(fake), "9", deadline_seconds=fake.seconds)
        self.assertNotIn("not listening", str(caught.exception))

    def test_a_restart_that_is_still_running_is_not_a_failure(self):
        fake = self.a_board(listens_at_restart=10**9, seconds=0.2)
        fake.read = lambda size: b""
        running = mock.Mock(poll=mock.Mock(return_value=None))
        with mock.patch.object(recover.subprocess, "Popen", return_value=running), \
                mock.patch.object(recover, "GREETING_EVERY", 0.01), \
                self.assertRaisesRegex(BoardError, "not listening"):
            recover.enter(link_to(fake), "9", deadline_seconds=fake.seconds)

    def test_giving_up_says_how_to_give_a_slow_board_longer(self):
        fake = self.a_board(listens_at_restart=10**9, seconds=0.2)
        fake.read = lambda size: b""
        with mock.patch.object(recover, "GREETING_EVERY", 0.01), \
                self.assertRaisesRegex(BoardError, rf"Button 2.*--wait {recover.ENTER_THROUGH_A_SWAP}"):
            recover.enter(link_to(fake), None, deadline_seconds=fake.seconds)

    def test_a_reply_with_a_bad_checksum_is_ignored(self):
        fake = FakeBootloader()
        link = link_to(fake)
        link.send(recover.OP_WRITE, recover.GROUP_OS, recover.ID_OS_ECHO, {"d": "x"})
        reply = bytearray(fake.reply)
        reply[-3] ^= 0x01
        fake.reply = bytes(reply)
        self.assertIsNone(link.receive(0.05))


if __name__ == "__main__":
    unittest.main()
