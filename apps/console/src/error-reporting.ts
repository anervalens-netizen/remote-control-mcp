import * as Sentry from "@sentry/react";
declare const __GLITCHTIP_DSN__: string;
declare const __GLITCHTIP_RELEASE__: string;
export function scrubErrorEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  delete event.request;
  delete event.user;
  delete event.extra;
  delete event.breadcrumbs;
  delete event.contexts;
  delete event.message;
  delete event.transaction;
  event.tags = Object.fromEntries(Object.entries(event.tags ?? {}).filter(([key]) =>
    ["application", "component", "request_id", "error_id", "validation.run", "glitchtip.synthetic"].includes(key)));
  for (const exception of event.exception?.values ?? []) {
    exception.value = "Application error (private message omitted)";
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
      delete frame.pre_context;
      delete frame.post_context;
      delete frame.context_line;
    }
  }
  return event;
}

if (__GLITCHTIP_DSN__) {
  Sentry.init({
    dsn: __GLITCHTIP_DSN__, environment: "production", release: __GLITCHTIP_RELEASE__,
    dataCollection: {userInfo:false,cookies:false,httpHeaders:{request:false,response:false},httpBodies:[],queryParams:false,genAI:{inputs:false,outputs:false},databaseQueryData:false,stackFrameVariables:false,frameContextLines:0}, tracesSampleRate: 0,
    initialScope: { tags: { application: "remote-control", component: "frontend" } },
    beforeSend: scrubErrorEvent,
  });
}
export const captureError = Sentry.captureException;
