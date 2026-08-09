/**
 * Miles Sound System (MSS) API Descriptor
 * 
 * Function signatures derived from @N suffix in exported names
 * where N is the total byte count of arguments (stdcall convention).
 * Some legacy exports ship with incorrect decoration (e.g. _AIL_file_read@8
 * actually takes 3 arguments); we override arg counts explicitly to keep
 * thunk stack cleanup correct.
 */

import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" });
    }
    return params;
};

const makeFunc = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
});

export const mss32Module: ModuleDescriptor = {
    name: "mss32",
    functions: [
        // File operations
        // NOTE: Different MSS versions have different signatures:
        // - @8 = 2 args: AIL_file_read(char* filename, void* dest) - older MSS
        // - @12 = 3 args: AIL_file_read(char* filename, void* dest, U32 size) - newer MSS
        // The @N decoration determines RET cleanup - must match to avoid stack corruption!
        makeFunc("_AIL_file_read@8", 2),   // @8 = 2 args (older MSS versions)
        makeFunc("_AIL_file_read@12", 3),  // @12 = 3 args (newer MSS versions)
        makeFunc("_AIL_file_size@4", 1),        // @4 = 1 arg
        makeFunc("_AIL_file_type@8", 2),      // @8 = 2 args (data, size)
        makeFunc("_AIL_WAV_info@8", 2),
        makeFunc("_AIL_decompress_ADPCM@12", 3),
        
        // Sample handle management
        makeFunc("_AIL_allocate_sample_handle@4", 1),  // @4 = 1 arg
        makeFunc("_AIL_release_sample_handle@4", 1),   // @4 = 1 arg
        
        // Sample initialization and control
        makeFunc("_AIL_init_sample@4", 1),              // @4 = 1 arg
        makeFunc("_AIL_start_sample@4", 1),              // @4 = 1 arg
        makeFunc("_AIL_stop_sample@4", 1),               // @4 = 1 arg
        makeFunc("_AIL_resume_sample@4", 1),             // @4 = 1 arg
        makeFunc("_AIL_end_sample@4", 1),                // @4 = 1 arg
        makeFunc("_AIL_sample_status@4", 1),            // @4 = 1 arg
        
        // Sample file operations
        makeFunc("_AIL_set_sample_file@12", 3),          // @12 = 3 args
        makeFunc("_AIL_set_named_sample_file@20", 5),    // @20 = 5 args
        
        // Sample properties
        makeFunc("_AIL_set_sample_volume@8", 2),         // @8 = 2 args
        makeFunc("_AIL_set_sample_pan@8", 2),            // @8 = 2 args
        makeFunc("_AIL_set_sample_playback_rate@8", 2),   // @8 = 2 args
        makeFunc("_AIL_set_sample_loop_count@8", 2),     // @8 = 2 args
        
        // Memory management
        makeFunc("_AIL_mem_free_lock@4", 1),             // @4 = 1 arg
        
        // System initialization
        makeFunc("_AIL_startup@0", 0),                    // @0 = 0 args
        makeFunc("_AIL_shutdown@0", 0),                  // @0 = 0 args
        makeFunc("_AIL_quick_startup@20", 5),
        makeFunc("_AIL_quick_shutdown@0", 0),
        makeFunc("_AIL_set_preference@8", 2),            // @8 = 2 args
        makeFunc("_MemSetPatching@4", 1),
        makeFunc("MemPoolInit", 0),
        
        // System service functions
        makeFunc("_AIL_serve@0", 0),                     // @0 = 0 args - process audio system
        makeFunc("_AIL_delay@4", 1),                     // @4 = 1 arg - delay (n * 1/60s)
        
        // Digital driver
        makeFunc("_AIL_open_digital_driver@4", 1),       // @4 = 1 arg
        // MSS 3.x spells it (frequency, bits, channels, flags). The decorated name carries
        // the byte count, so both versions coexist — but WITHOUT this entry the @16 import
        // falls back to the @4 row and returns with RET 4, drifting the caller's stack.
        makeFunc("_AIL_open_digital_driver@16", 4),
        
        // Wave output
        makeFunc("_AIL_waveOutOpen@16", 4),              // @16 = 4 args
        makeFunc("_AIL_waveOutClose@4", 1),
        makeFunc("_AIL_waveOutGetNumDevs@0", 0),
        makeFunc("_AIL_waveOutPrepareHeader@12", 3),
        makeFunc("_AIL_waveOutUnprepareHeader@12", 3),
        makeFunc("_AIL_waveOutWrite@12", 3),
        makeFunc("_AIL_waveOutReset@4", 1),
        // Stream API (often used by Bink/cutscenes)
        makeFunc("_AIL_set_stream_volume@8", 2),
        makeFunc("_AIL_get_preference@4", 1),
        makeFunc("_AIL_close_stream@4", 1),
        makeFunc("_AIL_open_stream@12", 3),
        makeFunc("_AIL_stream_info@8", 2),
        makeFunc("_AIL_set_stream_loop_count@8", 2),
        makeFunc("_AIL_stream_position@4", 1),
        makeFunc("_AIL_pause_stream@4", 1),
        makeFunc("_AIL_resume_stream@4", 1),
        makeFunc("_AIL_stream_position_ms@4", 1),
        makeFunc("_AIL_set_stream_position@8", 2),
        makeFunc("_AIL_set_stream_playback_rate@8", 2),
        makeFunc("_AIL_stream_status@4", 1),
        makeFunc("_AIL_load_sample_buffer@16", 4),
        makeFunc("_AIL_minimum_sample_buffer_size@12", 3),
        makeFunc("_AIL_set_sample_type@12", 3),
        makeFunc("_AIL_sample_buffer_ready@4", 1),
        makeFunc("_AIL_sample_buffer_info@20", 5),
        makeFunc("_AIL_set_sample_user_data@12", 3),
        // Digital driver config / service / HWND (often used by Bink/MSS)
        makeFunc("_AIL_digital_configuration@16", 4),
        makeFunc("_AIL_HWND@0", 0),
        makeFunc("_AIL_service_stream@8", 2),
        makeFunc("_AIL_close_digital_driver@4", 1),
        makeFunc("_AIL_mem_alloc_lock@4", 1),
        makeFunc("_AIL_redbook_open@4", 1),
        makeFunc("_AIL_redbook_close@4", 1),
        makeFunc("_AIL_redbook_open_drive@4", 1),
        makeFunc("_AIL_redbook_tracks@4", 1),
        makeFunc("_AIL_redbook_track_info@16", 4),
        makeFunc("_AIL_redbook_set_volume@8", 2),
        makeFunc("_AIL_redbook_volume@4", 1),
        makeFunc("_AIL_redbook_status@4", 1),
        makeFunc("_AIL_redbook_stop@4", 1),
        makeFunc("_AIL_redbook_play@12", 3),
        makeFunc("_AIL_redbook_pause@4", 1),
        makeFunc("_AIL_redbook_resume@4", 1),
        makeFunc("_AIL_redbook_position@4", 1),
        // 3D provider enumeration
        makeFunc("_AIL_enumerate_3D_providers@12", 3),
        makeFunc("_AIL_enumerate_filters@12", 3),
        makeFunc("_AIL_open_filter@8", 2),
        makeFunc("_AIL_set_filter_sample_preference@12", 3),
        makeFunc("_AIL_set_sample_processor@12", 3),
        makeFunc("_AIL_sample_ms_position@12", 3),
        makeFunc("_AIL_digital_CPU_percent@4", 1),
        makeFunc("_AIL_set_sample_loop_block@12", 3),
        makeFunc("_AIL_set_3D_sample_loop_block@12", 3),
        makeFunc("_AIL_set_3D_sample_obstruction@8", 2),
        makeFunc("_AIL_set_3D_sample_occlusion@8", 2),
        makeFunc("_AIL_set_3D_sample_preference@12", 3),
        makeFunc("_AIL_3D_sample_cone@16", 4),
        makeFunc("_AIL_3D_provider_attribute@12", 3),
        // 3D audio provider stubs
        makeFunc("_AIL_open_3D_provider@4", 1),
        makeFunc("_AIL_close_3D_provider@4", 1),
        makeFunc("_AIL_allocate_3D_sample_handle@4", 1),
        makeFunc("_AIL_release_3D_sample_handle@4", 1),
        makeFunc("_AIL_set_3D_sample_file@8", 2),
        makeFunc("_AIL_start_3D_sample@4", 1),
        makeFunc("_AIL_stop_3D_sample@4", 1),
        makeFunc("_AIL_set_3D_position@16", 4),
        makeFunc("_AIL_set_3D_velocity@20", 5),
        makeFunc("_AIL_set_3D_velocity_vector@16", 4),
        makeFunc("_AIL_set_3D_orientation@28", 7),
        // 3D getters — out-parameter twins of the setters above. An engine that
        // keeps no copy of what it set reads these back every frame.
        makeFunc("_AIL_3D_position@16", 4),
        makeFunc("_AIL_3D_velocity@16", 4),
        makeFunc("_AIL_3D_orientation@28", 7),
        makeFunc("_AIL_3D_sample_distances@12", 3),
        makeFunc("_AIL_set_3D_sample_volume@8", 2),
        makeFunc("_AIL_set_3D_sample_distances@12", 3),
        makeFunc("_AIL_set_3D_sample_cone@16", 4),
        makeFunc("_AIL_set_3D_sample_effects_level@8", 2),
        makeFunc("_AIL_set_3D_sample_playback_rate@8", 2),
        makeFunc("_AIL_3D_sample_playback_rate@4", 1),
        makeFunc("_AIL_set_3D_sample_loop_count@8", 2),
        makeFunc("_AIL_3D_sample_loop_count@4", 1),
        makeFunc("_AIL_3D_sample_volume@4", 1),
        makeFunc("_AIL_3D_sample_status@4", 1),
        makeFunc("_AIL_end_3D_sample@4", 1),
        makeFunc("_AIL_resume_3D_sample@4", 1),
        // 3D listener / environment
        makeFunc("_AIL_open_3D_listener@4", 1),
        makeFunc("_AIL_close_3D_listener@4", 1),
        makeFunc("_AIL_3D_room_type@4", 1),
        makeFunc("_AIL_set_3D_room_type@8", 2),
        makeFunc("_AIL_3D_speaker_type@4", 1),
        makeFunc("_AIL_set_3D_speaker_type@8", 2),
        makeFunc("_AIL_set_3D_provider_preference@12", 3),
        makeFunc("_AIL_quick_handles@12", 3),
        // Redist directory
        makeFunc("_AIL_set_redist_directory@4", 1),
        // Digital driver handle management (for background/focus changes)
        makeFunc("_AIL_digital_handle_release@4", 1),
        makeFunc("_AIL_digital_handle_reacquire@4", 1),
        // Raw sample data
        makeFunc("_AIL_set_sample_address@8", 2),
        makeFunc("_AIL_set_sample_address@12", 3),      // (S, start, len)
        // CPU features
        makeFunc("_AIL_MMX_available@0", 0),
        // Timer API (Miles 4.x often uses these)
        makeFunc("_AIL_register_timer@4", 1),
        makeFunc("_AIL_set_timer_user@8", 2),
        makeFunc("_AIL_set_timer_frequency@8", 2),
        makeFunc("_AIL_set_timer_period@8", 2),
        makeFunc("_AIL_start_timer@4", 1),
        makeFunc("_AIL_stop_timer@4", 1),
        makeFunc("_AIL_release_timer_handle@4", 1),
        // Driver install/uninstall
        makeFunc("_AIL_install_DIG_driver_file@8", 2),
        makeFunc("_AIL_uninstall_driver@4", 1),
        // Stream/sample volume and control (alternate decorations)
        makeFunc("_AIL_stream_volume@4", 1),
        makeFunc("_AIL_pause_stream@8", 2),
        makeFunc("_AIL_start_stream@4", 1),
        makeFunc("_AIL_sample_volume@4", 1),
        makeFunc("_AIL_sample_pan@4", 1),
        makeFunc("_AIL_sample_playback_rate@4", 1),
        makeFunc("_AIL_sample_loop_count@4", 1),
        makeFunc("_AIL_sample_position@4", 1),
        // Error and timing functions
        makeFunc("_AIL_last_error@0", 0),
        makeFunc("_AIL_set_error@4", 1),
        makeFunc("_AIL_ms_count@0", 0),
        makeFunc("_AIL_us_count@0", 0),
        // MIDI/Sequence API (XMIDI stubs)
        makeFunc("_AIL_allocate_sequence_handle@4", 1),
        makeFunc("_AIL_release_sequence_handle@4", 1),
        makeFunc("_AIL_init_sequence@12", 3),
        makeFunc("_AIL_start_sequence@4", 1),
        makeFunc("_AIL_stop_sequence@4", 1),
        makeFunc("_AIL_pause_sequence@4", 1),
        makeFunc("_AIL_resume_sequence@4", 1),
        makeFunc("_AIL_end_sequence@4", 1),
        makeFunc("_AIL_sequence_status@4", 1),
        makeFunc("_AIL_set_sequence_volume@12", 3),
        makeFunc("_AIL_sequence_volume@4", 1),
        makeFunc("_AIL_set_sequence_loop_count@8", 2),
        makeFunc("_AIL_sequence_loop_count@4", 1),
        makeFunc("_AIL_set_sequence_tempo@12", 3),
        makeFunc("_AIL_sequence_position@12", 3),
        // MIDI driver stubs
        makeFunc("_AIL_install_MDI_driver_file@8", 2),
        makeFunc("_AIL_open_XMIDI_driver@4", 1),
        makeFunc("_AIL_close_XMIDI_driver@4", 1),
        makeFunc("_AIL_uninstall_MDI_driver@4", 1),
        makeFunc("_AIL_MDI_driver_type@4", 1),
        makeFunc("_AIL_set_XMIDI_master_volume@8", 2),
        makeFunc("_AIL_XMIDI_master_volume@4", 1),
        // Digital master volume
        makeFunc("_AIL_set_digital_master_volume@8", 2),
        makeFunc("_AIL_digital_master_volume@4", 1),

        // Auto-generated from reference signatures
        makeFunc("AIL_allocate_sample_handle", 1),
        // RIB (Miles' Resource Interchange Broker) — every provider the engine loads
        // (.m3d/.flt/.asi decoders and 3D drivers) imports these two from mss32 to publish
        // its own entry points, so one missing name fails the whole provider's load.
        makeFunc("RIB_register_interface", 4),   // provider, interface_name, entry_count, entries
        makeFunc("RIB_unregister_interface", 4),
        makeFunc("AIL_close_digital_driver", 1),
        makeFunc("AIL_close_stream", 1),
        makeFunc("AIL_delay", 1),
        makeFunc("AIL_digital_configuration", 4),
        makeFunc("AIL_digital_handle_reacquire", 1),
        makeFunc("AIL_digital_handle_release", 1),
        makeFunc("AIL_end_sample", 1),
        makeFunc("AIL_file_read", 3),
        makeFunc("AIL_file_size", 1),
        makeFunc("AIL_file_type", 2),
        makeFunc("AIL_WAV_info", 2),
        makeFunc("AIL_decompress_ADPCM", 3),
        makeFunc("AIL_get_preference", 1),
        makeFunc("AIL_HWND", 0),
        makeFunc("AIL_init_sample", 1),
        makeFunc("AIL_install_DIG_driver_file", 2),
        makeFunc("AIL_last_error", 0),
        makeFunc("AIL_load_sample_buffer", 4),
        makeFunc("AIL_mem_alloc_lock", 1),
        makeFunc("AIL_mem_free_lock", 1),
        makeFunc("AIL_minimum_sample_buffer_size", 3),
        makeFunc("AIL_MMX_available", 0),
        makeFunc("AIL_ms_count", 0),
        makeFunc("AIL_open_digital_driver", 1),
        makeFunc("AIL_open_stream", 3),
        makeFunc("AIL_pause_stream", 2),
        makeFunc("AIL_redbook_close", 1),
        makeFunc("AIL_redbook_open", 1),
        makeFunc("AIL_register_timer", 1),
        makeFunc("AIL_release_sample_handle", 1),
        makeFunc("AIL_release_timer_handle", 1),
        makeFunc("AIL_resume_sample", 1),
        makeFunc("AIL_resume_stream", 1),
        makeFunc("AIL_sample_buffer_info", 5),
        makeFunc("AIL_sample_buffer_ready", 1),
        makeFunc("AIL_sample_loop_count", 1),
        makeFunc("AIL_sample_pan", 1),
        makeFunc("AIL_sample_playback_rate", 1),
        makeFunc("AIL_sample_position", 1),
        makeFunc("AIL_sample_status", 1),
        makeFunc("AIL_sample_volume", 1),
        makeFunc("AIL_serve", 0),
        makeFunc("AIL_service_stream", 2),
        makeFunc("AIL_set_error", 1),
        makeFunc("AIL_set_named_sample_file", 5),
        makeFunc("AIL_set_preference", 2),
        makeFunc("AIL_set_sample_address", 2),
        makeFunc("AIL_set_sample_file", 3),
        makeFunc("AIL_set_sample_loop_count", 2),
        makeFunc("AIL_set_sample_pan", 2),
        makeFunc("AIL_set_sample_playback_rate", 2),
        makeFunc("AIL_set_sample_type", 3),
        makeFunc("AIL_set_sample_user_data", 3),
        makeFunc("AIL_set_sample_volume", 2),
        makeFunc("AIL_set_stream_loop_count", 2),
        makeFunc("AIL_set_stream_playback_rate", 2),
        makeFunc("AIL_set_stream_position", 2),
        makeFunc("AIL_set_stream_volume", 2),
        makeFunc("AIL_set_timer_frequency", 2),
        makeFunc("AIL_set_timer_period", 2),
        makeFunc("AIL_set_timer_user", 2),
        makeFunc("AIL_shutdown", 0),
        makeFunc("AIL_quick_startup", 5),
        makeFunc("AIL_quick_shutdown", 0),
        makeFunc("AIL_start_sample", 1),
        makeFunc("AIL_start_stream", 1),
        makeFunc("AIL_start_timer", 1),
        makeFunc("AIL_startup", 0),
        makeFunc("AIL_stop_sample", 1),
        makeFunc("AIL_stop_timer", 1),
        makeFunc("AIL_stream_info", 2),
        makeFunc("AIL_stream_position", 1),
        makeFunc("AIL_stream_position_ms", 1),
        makeFunc("AIL_stream_status", 1),
        makeFunc("AIL_stream_volume", 1),
        makeFunc("AIL_uninstall_driver", 1),
        makeFunc("AIL_us_count", 0),
        makeFunc("AIL_waveOutClose", 1),
        makeFunc("AIL_waveOutGetNumDevs", 0),
        makeFunc("AIL_waveOutOpen", 4),
        makeFunc("AIL_waveOutPrepareHeader", 3),
        makeFunc("AIL_waveOutReset", 1),
        makeFunc("AIL_waveOutUnprepareHeader", 3),
        makeFunc("AIL_waveOutWrite", 3),
    ]
};
