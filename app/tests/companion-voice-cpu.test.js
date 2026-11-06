'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// CI does not download the optional voice runtime. An explicit interpreter can
// exercise these native tests on any host with CPU PyTorch already installed.
const configuredPython = process.env.CAPRI_TEST_VOICE_PYTHON;
const localPython = path.resolve(__dirname, '../../.tools/capri-qwen-voice/venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = configuredPython || (fs.existsSync(localPython) ? localPython : null);

test('CPU voice projection packing passes real small-model PyTorch checks', {
  skip: !python && 'optional native voice Python is not installed',
  timeout: 90000,
}, () => {
  const program = String.raw`
import gc
import importlib.util
import sys
import unittest
import weakref

assert 'torch' not in sys.modules
spec = importlib.util.spec_from_file_location('capri_voice_cpu_test', sys.argv[1])
cpu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cpu)
assert 'torch' not in sys.modules, 'importing the helper must not load Torch'

import torch
torch.set_num_threads(1)

NAMES = ('q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj')

class CustomLinear(torch.nn.Linear):
    pass

class SmallVoice(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.talker = torch.nn.Module()
        self.talker.layers = torch.nn.ModuleList([torch.nn.Module()])
        for index, name in enumerate(NAMES):
            setattr(self.talker.layers[0], name, torch.nn.Linear(
                8, 6, bias=index % 2 == 0, dtype=torch.bfloat16))
        self.talker.lm_head = torch.nn.Linear(8, 6, dtype=torch.bfloat16)
        self.talker.codec_head = torch.nn.Linear(8, 6, dtype=torch.bfloat16)
        self.talker.custom = torch.nn.Module()
        self.talker.custom.q_proj = CustomLinear(8, 6, dtype=torch.bfloat16)
        self.talker.q_proj_extra = torch.nn.Linear(8, 6, dtype=torch.bfloat16)
        self.speaker_encoder = torch.nn.ModuleDict({
            'q_proj': torch.nn.Linear(8, 6, dtype=torch.bfloat16)})
        self.tokenizer = torch.nn.ModuleDict({
            'up_proj': torch.nn.Linear(8, 6, dtype=torch.bfloat16)})
        self.talker_shadow = torch.nn.ModuleDict({
            'q_proj': torch.nn.Linear(8, 6, dtype=torch.bfloat16)})
        self.q_proj = torch.nn.Linear(8, 6, dtype=torch.bfloat16)
        self.eval()

class ProjectionTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(31)
        self.model = SmallVoice()

    def test_fp16_numeric_shape_dtype_bias_and_scope(self):
        preserved_names = ('talker.lm_head', 'talker.codec_head',
            'talker.custom.q_proj', 'talker.q_proj_extra',
            'speaker_encoder.q_proj', 'tokenizer.up_proj',
            'talker_shadow.q_proj', 'q_proj')
        preserved = {name: self.model.get_submodule(name) for name in preserved_names}
        value = torch.randn(2, 3, 8)
        with torch.no_grad():
            expected = {name: torch.nn.functional.linear(value,
                self.model.get_submodule('talker.layers.0.' + name).weight.float(),
                (self.model.get_submodule('talker.layers.0.' + name).bias.float()
                 if self.model.get_submodule('talker.layers.0.' + name).bias is not None
                 else None)) for name in NAMES}
        engine = torch.backends.quantized.engine
        self.assertEqual(cpu.prepare_cpu_projections(self.model),
                         {'mode': 'fp16', 'count': 7, 'converted': 7})
        self.assertEqual(torch.backends.quantized.engine, engine)
        for name in NAMES:
            projection = self.model.get_submodule('talker.layers.0.' + name)
            self.assertFalse(projection.training)
            self.assertFalse(projection.packed.training)
            for dtype in (torch.float32, torch.bfloat16):
                actual = projection(value.to(dtype))
                self.assertEqual(actual.shape, (2, 3, 6))
                self.assertEqual(actual.dtype, dtype)
                torch.testing.assert_close(actual.float(), expected[name],
                    rtol=0.025, atol=0.012)
        for name, original in preserved.items():
            self.assertIs(self.model.get_submodule(name), original)

    def test_bias_is_not_dropped(self):
        with torch.no_grad():
            self.model.talker.layers[0].q_proj.weight.zero_()
            self.model.talker.layers[0].q_proj.bias.copy_(
                torch.tensor([0.5, -0.25, 1, -1, 2, 0], dtype=torch.bfloat16))
        expected = self.model.talker.layers[0].q_proj.bias.detach().clone()
        cpu.prepare_cpu_projections(self.model)
        actual = self.model.talker.layers[0].q_proj(torch.zeros(2, 8, dtype=torch.bfloat16))
        torch.testing.assert_close(actual, expected.expand(2, 6), rtol=0, atol=0)

    def test_repeated_mode_is_idempotent_and_other_mode_requires_reload(self):
        cpu.prepare_cpu_projections(self.model)
        originals = {name: self.model.get_submodule('talker.layers.0.' + name) for name in NAMES}
        self.assertEqual(cpu.prepare_cpu_projections(self.model),
                         {'mode': 'fp16', 'count': 7, 'converted': 0})
        with self.assertRaisesRegex(RuntimeError, 'reloading'):
            cpu.prepare_cpu_projections(self.model, mode='int8')
        for name, original in originals.items():
            self.assertIs(self.model.get_submodule('talker.layers.0.' + name), original)

    def test_original_bf16_modules_and_parameters_are_released(self):
        refs = []
        for name in NAMES:
            refs.append(weakref.ref(self.model.get_submodule('talker.layers.0.' + name)))
            refs.append(weakref.ref(self.model.get_submodule('talker.layers.0.' + name).weight))
            if self.model.get_submodule('talker.layers.0.' + name).bias is not None:
                refs.append(weakref.ref(self.model.get_submodule('talker.layers.0.' + name).bias))
        cpu.prepare_cpu_projections(self.model)
        gc.collect()
        self.assertTrue(all(reference() is None for reference in refs),
                        'packing must not retain original modules or BF16 parameters')

    def test_int8_is_per_channel_and_retains_dtype_and_reasonable_values(self):
        value = torch.randn(2, 8, dtype=torch.bfloat16)
        with torch.no_grad():
            expected = self.model.talker.layers[0].q_proj(value)
        self.assertEqual(cpu.prepare_cpu_projections(self.model, mode='int8'),
                         {'mode': 'int8', 'count': 7, 'converted': 7})
        projection = self.model.talker.layers[0].q_proj
        self.assertEqual(projection.packed.weight().qscheme(), torch.per_channel_affine)
        actual = projection(value)
        self.assertEqual(actual.dtype, value.dtype)
        torch.testing.assert_close(actual, expected, rtol=0.08, atol=0.03)
        self.assertEqual(cpu.prepare_cpu_projections(self.model, mode='int8')['converted'], 0)

    def test_missing_layers_and_invalid_mode_have_bounded_errors(self):
        for mode in ('', None, 'automatic'):
            with self.assertRaisesRegex(ValueError, 'mode'):
                cpu.prepare_cpu_projections(self.model, mode=mode)
        with self.assertRaisesRegex(RuntimeError, 'No supported talker'):
            cpu.prepare_cpu_projections(torch.nn.Linear(8, 6))
        with self.assertRaisesRegex(TypeError, 'PyTorch model'):
            cpu.prepare_cpu_projections(object())

    def test_missing_cpu_backend_reports_failure_without_replacing_layers(self):
        original_engine = torch.backends.quantized.engine
        try:
            torch.backends.quantized.engine = 'none'
            with self.assertRaisesRegex(RuntimeError, 'No quantized CPU backend'):
                cpu.prepare_cpu_projections(self.model)
            self.assertIs(type(self.model.talker.layers[0].q_proj), torch.nn.Linear)
        finally:
            torch.backends.quantized.engine = original_engine

    def test_non_cpu_layers_fail_before_partial_replacement(self):
        self.model.talker.layers[0].down_proj = torch.nn.Linear(8, 6, device='meta')
        with self.assertRaisesRegex(RuntimeError, 'must be on CPU'):
            cpu.prepare_cpu_projections(self.model)
        self.assertIs(type(self.model.talker.layers[0].q_proj), torch.nn.Linear)

unittest.main(argv=[sys.argv[0]], verbosity=2)
`;
  const result = spawnSync(python, ['-I', '-B', '-c', program,
    path.resolve(__dirname, '../src/main/companion-voice-cpu.py')], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 85000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  assert.match(result.stderr, /Ran 8 tests/);
  assert.match(result.stderr, /\bOK\b/);
});
