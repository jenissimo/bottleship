/**
 * DirectShow GUIDs and constants for quartz.dll
 */

// CLSIDs
export const CLSID_FilterGraph = "e436ebb3-524f-11ce-9f53-0020af0ba770";

// IIDs (lowercase normalized)
export const IID_IGraphBuilder    = "56a868a9-0ad4-11ce-b03a-0020af0ba770";
export const IID_IMediaControl    = "56a868b1-0ad4-11ce-b03a-0020af0ba770";
export const IID_IMediaPosition   = "56a868b2-0ad4-11ce-b03a-0020af0ba770";
export const IID_IMediaEvent      = "56a868b6-0ad4-11ce-b03a-0020af0ba770";
export const IID_IBasicVideo      = "56a868b5-0ad4-11ce-b03a-0020af0ba770";
export const IID_IMediaEventEx    = "56a868c0-0ad4-11ce-b03a-0020af0ba770";
export const IID_IVideoWindow     = "56a868b4-0ad4-11ce-b03a-0020af0ba770";
export const IID_IBasicAudio      = "56a868b3-0ad4-11ce-b03a-0020af0ba770";
export const IID_IFilterGraph     = "56a8689f-0ad4-11ce-b03a-0020af0ba770";
export const IID_IMediaFilter     = "56a86899-0ad4-11ce-b03a-0020af0ba770";
export const IID_IPersist         = "0000010c-0000-0000-c000-000000000046";
export const IID_IMediaSeeking    = "36b73880-c2c8-11cf-8b46-00805f6cef60";

// Time-format GUIDs (uuids.h). MEDIA_TIME = 100ns REFERENCE_TIME units (the default).
export const TIME_FORMAT_NONE         = "00000000-0000-0000-0000-000000000000";
export const TIME_FORMAT_FRAME        = "7b785572-8c82-11cf-bc0c-00aa00ac74f6";
export const TIME_FORMAT_MEDIA_TIME   = "7b785574-8c82-11cf-bc0c-00aa00ac74f6";

// AM_SEEKING_SEEKING_CAPABILITIES (returned by GetCapabilities)
export const AM_SEEKING_CanSeekAbsolute  = 0x001;
export const AM_SEEKING_CanSeekForwards  = 0x002;
export const AM_SEEKING_CanSeekBackwards = 0x004;
export const AM_SEEKING_CanGetCurrentPos = 0x008;
export const AM_SEEKING_CanGetStopPos    = 0x010;
export const AM_SEEKING_CanGetDuration   = 0x020;

// AM_SEEKING_SEEKING_FLAGS (dwCurrentFlags/dwStopFlags in SetPositions)
export const AM_SEEKING_NoPositioning          = 0x0;
export const AM_SEEKING_AbsolutePositioning    = 0x1;
export const AM_SEEKING_RelativePositioning    = 0x2;
export const AM_SEEKING_IncrementalPositioning = 0x3;
export const AM_SEEKING_PositioningBitsMask    = 0x3;

// REFERENCE_TIME units per second (100ns ticks).
export const REFTIME_UNITS_PER_SECOND = 10_000_000;

// HRESULT codes
export const S_OK            = 0x00000000;
export const S_FALSE         = 0x00000001;
export const E_NOINTERFACE   = 0x80004002;
export const E_POINTER       = 0x80004003;
export const E_FAIL          = 0x80004005;
export const E_NOTIMPL       = 0x80004001;
export const E_ABORT         = 0x80004004;
export const VFW_E_NOT_FOUND = 0x80040216;

// Media event codes
export const EC_COMPLETE     = 0x01;
export const EC_USERABORT    = 0x02;
export const EC_ERRORABORT   = 0x03;

// Filter states
export enum FilterState {
    STOPPED     = 0,
    PAUSED      = 1,
    RUNNING     = 2,
    COMPLETED   = 3,  // Internal — video finished
}
