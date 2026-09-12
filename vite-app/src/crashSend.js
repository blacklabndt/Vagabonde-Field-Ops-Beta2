// The one line of crash reporting that needs a browser.
//
// crashReport.js holds the judgement and the twin of the server's rules and
// imports nothing, so `node --test` can run the send itself. This file is
// the client it runs against: the Supabase function call, bound once.

import { sbClient } from "./config.js";
import { makeReportCrash } from "./crashReport.js";

export const reportCrash = makeReportCrash(body => sbClient.functions.invoke("report-error", { body }));
