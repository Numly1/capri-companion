'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The optional portable Python is reused; these tests never import the real
// model, download weights, or start a production voice service.
const configuredPython = process.env.CAPRI_TEST_VOICE_PYTHON;
const localPython = path.resolve(__dirname, '../../.tools/capri-qwen-voice/venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = configuredPython || (fs.existsSync(localPython) ? localPython : null);

test('bundled Qwen server preserves cached voice and serves only local clients', {
  skip: !python && 'optional native voice Python is not installed',
  timeout: 30000,
}, () => {
  const program = String.raw`
import builtins
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch
import wave

spec = importlib.util.spec_from_file_location('capri_qwen_server_test', sys.argv[1])
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
assert 'torch' not in sys.modules, 'cached voice must not import Torch at startup'
assert 'qwen_tts' not in sys.modules

REFERENCE = b'capri-reference-fixture\0' * 4
PHRASE = 'Свой темп тоже считается.'

def wav_bytes():
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(b'\0\0' * 120)
    return output.getvalue()

class ServiceFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='capri-qwen-test-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.reference = self.directory / 'reference.audio'
        self.reference.write_bytes(REFERENCE)
        self.service = server.VoiceService(self.reference, self.directory / 'runtime', offline=True)
        self.addCleanup(self.service.worker.shutdown, wait=True)

class HttpTests(ServiceFixture):
    def setUp(self):
        super().setUp()
        self.load_calls = 0
        def no_model():
            self.load_calls += 1
            raise AssertionError('HTTP fixture must never load a model')
        self.service._load = no_model
        self.http = server.LocalServer(('127.0.0.1', 0), server.handler_for(self.service))
        self.worker = threading.Thread(target=self.http.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        self.worker.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.http.shutdown()
        self.http.server_close()
        self.worker.join(timeout=2)
        self.assertFalse(self.worker.is_alive())
        self.assertEqual(self.load_calls, 0)
        self.assertNotIn('torch', sys.modules)
        self.assertNotIn('qwen_tts', sys.modules)

    def request(self, method, route, data=None, headers=None, raw=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.http.server_port, timeout=3)
        body = raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
        try:
            connection.request(method, route, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_health_identifies_lazy_local_backend_without_loading_torch(self):
        status, headers, body = self.request('GET', '/health', headers={'Host': 'localhost'})
        self.assertEqual(status, 200)
        health = json.loads(body)
        self.assertTrue(health['ok'])
        self.assertEqual(health['state'], 'unloaded')
        self.assertEqual(health['model'], 'qwen3-tts-1.7b-capri')
        self.assertEqual(health['modelRevision'], 'fd4b254389122332181a7c3db7f27e918eec64e3')
        self.assertEqual(health['backendVersion'], 'capri-cpu-fp16-2')
        self.assertEqual(health['storageBackend'], 'pread')
        self.assertEqual(health['cpuPrecision'], 'fp16-projections-fp32')
        self.assertEqual(health['referenceSHA256'], hashlib.sha256(REFERENCE).hexdigest())
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertNotIn('Access-Control-Allow-Origin', headers)

    def test_browser_origins_and_nonlocal_hosts_are_rejected(self):
        for headers in ({'Origin': 'https://example.invalid'}, {'Host': 'example.invalid'},
                        {'Origin': 'null'}, {'Host': '127.0.0.1.attacker.invalid'}):
            for method, route in (('GET', '/health'), ('POST', '/tts')):
                with self.subTest(headers=headers, method=method):
                    status, _, body = self.request(method, route, {'text': PHRASE}, headers)
                    self.assertEqual(status, 403)
                    self.assertEqual(json.loads(body)['code'], 'local_only')

    def test_invalid_requests_do_not_reach_model(self):
        requests = ({}, [], {'text': None}, {'text': 123}, {'text': []},
                    {'text': ''}, {'text': '   '}, {'text': 'a' * 401},
                    {'text': PHRASE, 'voice': 'other'})
        for data in requests:
            with self.subTest(data=data):
                status, _, body = self.request('POST', '/tts', data)
                self.assertEqual(status, 400)
                self.assertEqual(json.loads(body)['code'], 'invalid_request')
        status, _, body = self.request('POST', '/tts', raw=b'{broken')
        self.assertEqual((status, json.loads(body)['code']), (400, 'invalid_request'))
        for raw in (b'', b'x' * 12001):
            status, _, body = self.request('POST', '/tts', raw=raw)
            self.assertEqual((status, json.loads(body)['code']), (413, 'request_size'))

    def test_existing_cached_wav_is_returned_byte_exact_without_model(self):
        audio = wav_bytes()
        cache = self.service.cache_file(PHRASE)
        # Frozen legacy cache key: precision/loader updates must not discard
        # the voice already prepared on the recipient's PC.
        self.assertEqual(cache.name, '9276ac420ec2ed6b7d394529f62748f8884760c19a7cfcecbbd40c22895f6f44.wav')
        cache.parent.mkdir(parents=True)
        cache.write_bytes(audio)
        status, headers, body = self.request('POST', '/tts', {'text': '  ' + PHRASE + '  '})
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'audio/wav')
        self.assertEqual(int(headers['Content-Length']), len(audio))
        self.assertEqual(body, audio)
        self.assertIsNone(self.service.model)
        self.assertEqual(self.service.health()['state'], 'cached')

    def test_missing_reference_busy_service_and_unknown_route_have_bounded_errors(self):
        self.service.lock.acquire()
        try:
            status, _, body = self.request('POST', '/tts', {'text': PHRASE})
            self.assertEqual((status, json.loads(body)['code']), (409, 'voice_busy'))
        finally:
            self.service.lock.release()
        self.reference.unlink()
        status, _, body = self.request('POST', '/tts', {'text': PHRASE})
        self.assertEqual((status, json.loads(body)['code']), (503, 'reference_missing'))
        for method in ('GET', 'POST'):
            status, _, body = self.request(method, '/not-a-voice-route', {})
            self.assertEqual((status, json.loads(body)['code']), (404, 'not_found'))

class LoaderTests(ServiceFixture):
    def fake_dependencies(self):
        self.events = []
        safetensors = types.ModuleType('safetensors')
        def safe_open(*args, **kwargs):
            self.events.append(('read', args, kwargs))
            return 'tensor-reader'
        safetensors.safe_open = safe_open
        torch = types.ModuleType('torch')
        torch.bfloat16 = object()
        torch.set_num_threads = lambda threads: self.events.append(('threads', threads))
        torch.set_num_interop_threads = lambda threads: self.events.append(('interop', threads))
        self.candidate = object()
        self.load_kwargs = None
        def from_pretrained(model_path, **kwargs):
            self.assertEqual(model_path, 'installed-cached-model')
            self.assertIsNone(self.service.model)
            self.load_kwargs = kwargs
            self.events.append(('load',))
            return self.candidate
        qwen = types.ModuleType('qwen_tts')
        qwen.Qwen3TTSModel = types.SimpleNamespace(from_pretrained=from_pretrained)
        self.addCleanup(patch.stopall)
        patch.dict(sys.modules, {'safetensors': safetensors, 'torch': torch, 'qwen_tts': qwen}).start()
        original_import = builtins.__import__
        def checked_import(name, *args, **kwargs):
            if name in ('torch', 'qwen_tts'):
                self.assertEqual(os.environ.get('ONEDNN_PRIMITIVE_CACHE_CAPACITY'), '0')
                self.assertEqual(os.environ.get('DNNL_PRIMITIVE_CACHE_CAPACITY'), '0')
            if name == 'qwen_tts':
                # Transformers may bind safe_open at import time. The reader
                # must already force pread before that import occurs.
                self.assertTrue(getattr(safetensors.safe_open, '_capri_pread', False))
                self.assertEqual(safetensors.safe_open('checkpoint', framework='pt', backend='mmap'), 'tensor-reader')
                self.assertEqual(self.events[-1][2]['backend'], 'pread')
                self.events.append(('qwen-import',))
            return original_import(name, *args, **kwargs)
        patch('builtins.__import__', checked_import).start()
        self.service.download = lambda: 'installed-cached-model'
        return torch, safetensors

    def test_loader_prepares_small_weights_before_publishing_ready_model(self):
        torch, _ = self.fake_dependencies()
        def prepare(model):
            self.assertIs(model, self.candidate)
            self.assertIsNone(self.service.model)
            self.assertEqual(self.service.state, 'loading')
            self.events.append(('prepare',))
        with patch.object(server, 'prepare_cpu_model', prepare):
            self.service._load()
            self.assertIs(self.load_kwargs['dtype'], torch.bfloat16)
            self.assertEqual(self.load_kwargs['device_map'], 'cpu')
            self.assertTrue(self.load_kwargs['local_files_only'])
            self.assertEqual(self.service.state, 'ready')
            self.assertIs(self.service.model, self.candidate)
            self.assertIsNone(self.service.last_error)
            self.assertLess(self.events.index(('load',)), self.events.index(('prepare',)))
            before = list(self.events)
            self.service._load()
            self.assertEqual(self.events, before, 'an already loaded model must not be rebuilt')

    def test_prepare_failure_does_not_publish_partially_prepared_model_and_can_retry(self):
        self.fake_dependencies()
        with patch.object(server, 'prepare_cpu_model', side_effect=RuntimeError('test packing failure')):
            with self.assertRaisesRegex(RuntimeError, 'test packing failure'):
                self.service._load()
        self.assertIsNone(self.service.model)
        health = self.service.health()
        self.assertFalse(health['ok'])
        self.assertEqual(health['state'], 'error')
        self.assertTrue(health['retryable'])
        self.assertNotIn('test packing failure', health['error'])
        with patch.object(server, 'prepare_cpu_model') as prepare:
            self.service._load()
        prepare.assert_called_once_with(self.candidate)
        self.assertEqual(self.service.state, 'ready')
        self.assertIs(self.service.model, self.candidate)

    def test_pread_wrapper_is_idempotent_and_changes_only_reader_backend(self):
        _, safetensors = self.fake_dependencies()
        server.prepare_weight_reader()
        reader = safetensors.safe_open
        server.prepare_weight_reader()
        self.assertIs(safetensors.safe_open, reader)
        self.assertEqual(reader('local-weights', framework='pt', device='cpu'), 'tensor-reader')
        self.assertEqual(self.events[-1], ('read', ('local-weights',),
            {'framework': 'pt', 'device': 'cpu', 'backend': 'pread'}))

    def test_reference_change_uses_new_cache_identity_without_deleting_old_audio(self):
        old_cache = self.service.cache_file(PHRASE)
        self.service.write_cache(old_cache, wav_bytes())
        self.reference.write_bytes(REFERENCE + b'changed')
        new_cache = self.service.cache_file(PHRASE)
        self.assertNotEqual(old_cache, new_cache)
        self.assertTrue(old_cache.is_file())
        self.assertIsNone(self.service.read_cache(new_cache))

class WorkerTests(ServiceFixture):
    def test_different_live_callers_use_the_same_persistent_inference_thread(self):
        callers = {}
        inference_threads = []
        results = {}
        errors = []
        starts = [threading.Event(), threading.Event()]
        completed = [threading.Event(), threading.Event()]
        keep_callers_alive = threading.Event()
        def synthesize(text):
            inference_threads.append(threading.get_ident())
            return text.encode()
        self.service._synthesize = synthesize
        def caller(index):
            try:
                if not starts[index].wait(3):
                    raise AssertionError('caller did not start')
                callers[index] = threading.get_ident()
                results[index] = self.service.synthesize('phrase-' + str(index))
            except BaseException as error:
                errors.append(error)
            finally:
                completed[index].set()
                keep_callers_alive.wait(3)
        threads = [threading.Thread(target=caller, args=(index,), daemon=True) for index in range(2)]
        for thread in threads:
            thread.start()
        try:
            starts[0].set()
            self.assertTrue(completed[0].wait(2))
            starts[1].set()
            self.assertTrue(completed[1].wait(2))
        finally:
            for start in starts:
                start.set()
            keep_callers_alive.set()
            for thread in threads:
                thread.join(timeout=3)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertEqual(results, {0: b'phrase-0', 1: b'phrase-1'})
        self.assertEqual(len(set(callers.values())), 2, 'keep both callers alive to prevent thread-ID reuse')
        self.assertEqual(len(inference_threads), 2)
        self.assertEqual(len(set(inference_threads)), 1)
        self.assertTrue(set(inference_threads).isdisjoint(callers.values()))

    def test_busy_request_is_rejected_before_worker_becomes_available(self):
        entered = threading.Event()
        release = threading.Event()
        busy_finished = threading.Event()
        calls, accepted, rejected, errors = [], [], [], []
        def synthesize(text):
            calls.append(text)
            entered.set()
            if not release.wait(4):
                raise AssertionError('blocked inference was not released')
            return b'first-audio'
        self.service._synthesize = synthesize
        def first_caller():
            try:
                accepted.append(self.service.synthesize('first'))
            except BaseException as error:
                errors.append(error)
        def busy_caller():
            try:
                self.service.synthesize('must-not-be-queued')
                errors.append(AssertionError('busy request was unexpectedly accepted'))
            except BlockingIOError:
                rejected.append(True)
            except BaseException as error:
                errors.append(error)
            finally:
                busy_finished.set()
        first = threading.Thread(target=first_caller, daemon=True)
        busy = threading.Thread(target=busy_caller, daemon=True)
        first.start()
        try:
            self.assertTrue(entered.wait(2))
            busy.start()
            self.assertTrue(busy_finished.wait(1), 'reject busy requests while inference is still blocked')
            self.assertFalse(release.is_set())
            self.assertEqual(calls, ['first'])
        finally:
            release.set()
            first.join(timeout=3)
            if busy.ident is not None:
                busy.join(timeout=3)
        self.assertFalse(first.is_alive())
        self.assertFalse(busy.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(rejected, [True])
        self.assertEqual(accepted, [b'first-audio'])
        self.assertEqual(calls, ['first'], 'rejected speech must never execute later')

    def test_worker_failure_releases_gate_and_next_request_uses_same_worker(self):
        inference_threads = []
        def synthesize(text):
            inference_threads.append(threading.get_ident())
            if text == 'fails':
                raise RuntimeError('fixture failure')
            return b'recovered-audio'
        self.service._synthesize = synthesize
        with self.assertRaisesRegex(RuntimeError, 'fixture failure'):
            self.service.synthesize('fails')
        self.assertFalse(self.service.lock.locked())
        self.assertEqual(self.service.synthesize('next'), b'recovered-audio')
        self.assertFalse(self.service.lock.locked())
        self.assertEqual(len(inference_threads), 2)
        self.assertEqual(len(set(inference_threads)), 1)
        self.assertNotEqual(inference_threads[0], threading.get_ident())

unittest.main(argv=[sys.argv[0]], verbosity=2)
`;
  const result = spawnSync(python, ['-I', '-B', '-c', program,
    path.resolve(__dirname, '../src/main/companion-qwen-server.py')], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 25000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  assert.match(result.stderr, /Ran 12 tests/);
  assert.match(result.stderr, /\bOK\b/);
});
