declare namespace wasm_bindgen {
	/* tslint:disable */
	/* eslint-disable */
	
	export class FfsubsyncOptions {
	  free(): void;
	  [Symbol.dispose](): void;
	  constructor();
	  /**
	   * Frame size in milliseconds (default 10).
	   */
	  frame_ms: number;
	  /**
	   * Maximum absolute offset to search in milliseconds (default 60000).
	   */
	  max_offset_ms: number;
	  /**
	   * Use golden-section search for drift detection (default false).
	   */
	  gss: boolean;
	  /**
	   * Expected sample rate of incoming PCM (default 16000).
	   */
	  sample_rate: number;
	  /**
	   * VAD aggressiveness 0..3 (controls energy threshold).
	   */
	  vad_aggressiveness: number;
	}
	
	export class FfsubsyncResult {
	  free(): void;
	  [Symbol.dispose](): void;
	  constructor();
	  offset_ms: number;
	  drift: number;
	  confidence: number;
	  segments_used: number;
	  srt: string;
	}
	
	export function align_pcm(pcm: Int16Array, opts: any, srt: string): FfsubsyncResult;
	
	export function align_wav(wav_bytes: Uint8Array, opts: any, srt: string): FfsubsyncResult;
	
}

declare type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

declare interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_ffsubsyncoptions_free: (a: number, b: number) => void;
  readonly __wbg_ffsubsyncresult_free: (a: number, b: number) => void;
  readonly __wbg_get_ffsubsyncoptions_frame_ms: (a: number) => number;
  readonly __wbg_get_ffsubsyncoptions_gss: (a: number) => number;
  readonly __wbg_get_ffsubsyncoptions_max_offset_ms: (a: number) => number;
  readonly __wbg_get_ffsubsyncoptions_sample_rate: (a: number) => number;
  readonly __wbg_get_ffsubsyncoptions_vad_aggressiveness: (a: number) => number;
  readonly __wbg_get_ffsubsyncresult_confidence: (a: number) => number;
  readonly __wbg_get_ffsubsyncresult_drift: (a: number) => number;
  readonly __wbg_get_ffsubsyncresult_offset_ms: (a: number) => number;
  readonly __wbg_get_ffsubsyncresult_segments_used: (a: number) => number;
  readonly __wbg_get_ffsubsyncresult_srt: (a: number) => [number, number];
  readonly __wbg_set_ffsubsyncoptions_frame_ms: (a: number, b: number) => void;
  readonly __wbg_set_ffsubsyncoptions_gss: (a: number, b: number) => void;
  readonly __wbg_set_ffsubsyncoptions_max_offset_ms: (a: number, b: number) => void;
  readonly __wbg_set_ffsubsyncoptions_sample_rate: (a: number, b: number) => void;
  readonly __wbg_set_ffsubsyncoptions_vad_aggressiveness: (a: number, b: number) => void;
  readonly __wbg_set_ffsubsyncresult_confidence: (a: number, b: number) => void;
  readonly __wbg_set_ffsubsyncresult_drift: (a: number, b: number) => void;
  readonly __wbg_set_ffsubsyncresult_offset_ms: (a: number, b: number) => void;
  readonly __wbg_set_ffsubsyncresult_segments_used: (a: number, b: number) => void;
  readonly __wbg_set_ffsubsyncresult_srt: (a: number, b: number, c: number) => void;
  readonly align_pcm: (a: number, b: number, c: any, d: number, e: number) => [number, number, number];
  readonly align_wav: (a: number, b: number, c: any, d: number, e: number) => [number, number, number];
  readonly ffsubsyncoptions_new: () => number;
  readonly ffsubsyncresult_new: () => number;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
declare function wasm_bindgen (module_or_path: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
