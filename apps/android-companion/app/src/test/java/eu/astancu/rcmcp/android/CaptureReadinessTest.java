package eu.astancu.rcmcp.android;
import org.junit.Test;
import static org.junit.Assert.*;
public final class CaptureReadinessTest {
 @Test public void modernAndroidUsesAccessibilityWithoutProjectionConsent() {
  assertEquals("accessibility_ready",CaptureReadiness.reason(30,true,"screen_sharing_consent_required"));
  assertEquals("accessibility_ready",CaptureReadiness.reason(36,true,"screen_sharing_consent_denied"));
 }
 @Test public void androidTenRequiresLiveProjection() {
  assertEquals("projection_active",CaptureReadiness.reason(29,true,"active"));
  assertEquals("screen_sharing_consent_required",CaptureReadiness.reason(29,true,"screen_sharing_consent_denied"));
  assertEquals("screen_sharing_consent_required",CaptureReadiness.reason(29,true,"screen_sharing_consent_required"));
  assertEquals("screen_sharing_unavailable",CaptureReadiness.reason(29,true,"rotation_changed"));
 }
 @Test public void unavailableAccessibilityTakesPrecedence() {
  assertEquals("accessibility_unavailable",CaptureReadiness.reason(29,false,"active"));
  assertEquals("accessibility_unavailable",CaptureReadiness.reason(36,false,"active"));
  assertEquals("screenshot_unsupported",CaptureReadiness.reason(28,true,"active"));
 }
}
