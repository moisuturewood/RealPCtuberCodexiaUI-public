import struct
import unittest

from tools.wav_player_worker import WaveOutPlayer, scale_pcm


class WavVolumeTests(unittest.TestCase):
    def test_signed_pcm_scaling_and_original(self):
        samples = struct.pack("<hhh", -20000, 0, 20000)
        self.assertEqual(scale_pcm(samples, 2, 100), samples)
        self.assertEqual(struct.unpack("<hhh", scale_pcm(samples, 2, 50)), (-10000, 0, 10000))
        self.assertEqual(scale_pcm(samples, 2, 0), bytes(len(samples)))

    def test_unsigned_eight_bit_silence(self):
        self.assertEqual(scale_pcm(bytes([0, 128, 255]), 1, 0), bytes([128, 128, 128]))

    def test_volume_validation(self):
        player = WaveOutPlayer()
        for invalid in (-1, 101, 0.5, True):
            with self.assertRaises(ValueError):
                player.set_volume(invalid)
        player.set_volume(50)
        self.assertEqual(player._volume, 50)


if __name__ == "__main__":
    unittest.main()
