// What each screen is for, in the words you would use to a new hire.
//
// The three markdown files that explain this app live in the repository,
// where nobody in the field or the office will ever read them. This is the
// same knowledge where the question actually gets asked: behind the "?" in
// the top bar, on the screen it is about.
//
// Pure data on purpose — no imports, no JSX, nothing to render. That keeps
// it testable next door (help.test.mjs checks every screen in TABS has an
// entry) and keeps the wording in one file rather than sprinkled through
// fifteen components.
//
// House style is the Admin screen's inline notes: short honest paragraphs,
// plain English, what the screen is for, what the buttons do, and the one
// or two rules that surprise people. Where a rule depends on the account's
// role, say so — "Admins and Technicians see prices" is the answer to a
// question people otherwise ask as "why is my screen broken".

// Keyed by the screen key in TABS. Each entry: the screen's own name, and
// the paragraphs, in reading order.
export const HELP = {
  board: {
    heading: "Home",
    body: [
      "From this screen you see and open any of the created jobs, you can search through them, filter them and create new jobs using the +Job button on the top right of your screen. You can also create a new ticket within any active job using the +Ticket button also located at the top of your screen next to the +Job button. Press the hamburger menu button to see the other available tabs."
    ]
  },
  job: {
    heading: "Job detail",
    body: [
      "From this screen you can see the job details, open, create and send JHAs, and Tickets as well as upload and send reports. When you upload a report the numbers should be automatically read and displayed but please double check they are correct for the next technician"
    ]
  },
  jha: {
    heading: "JHA builder",
    body: [
      "From this screen you can build your JHA... Self explanatory"
    ]
  },
  upload: {
    heading: "Report upload",
    body: [
      "Upload and send your report from this screen"
    ]
  },
  ticket: {
    heading: "Billing ticket",
    body: [
      "From here you build your ticket that will be sent to the client. Be sure to add your helper on to this as well as his hours are calculated from this screen"
    ]
  },
  mytickets: {
    heading: "Open tickets",
    body: [
      "On this screen you can see all of your own open tickets that have yet to be sent to your clients. Think of this screen as your to-do list for the end of each day"
    ]
  },
  chat: {
    heading: "Team chat",
    body: [
      "A bunch of degenerates getting into nonsense here, but every once and a while the boss might post something important, keep an eye on the pinned posts at the top of the screen"
    ]
  },
  files: {
    heading: "Files",
    body: [
      "Templates, decay charts, study material and other important docs can be stored here"
    ]
  },
  contacts: {
    heading: "Contacts",
    body: [
      "All the client and contractor contact info, make sure its correct, this is the same info that will be used to send reports and billing out"
    ]
  },
  equipment: {
    heading: "Equipment",
    body: [
      "The fleet: exposure devices, survey meters, dosimeters and tools, with serials, calibration dates and who has each one.",
      "The two tiles at the top only appear when there is something to act on — anything overdue for calibration, and anything due inside 30 days. Overdue means pull it from service.",
      "Assigning equipment to a person is what makes the JHA builder pre-fill their kit. If a worker's dosimeter is wrong on an assessment, it is wrong here.",
      "The filters are by kind; the search covers serial, type and the person it is assigned to."
    ]
  },
  timesheets: {
    heading: "Timesheets",
    body: [
      "The most important page, double check that your hours are correct before sending it off for approval, you dont want anything missed!"
    ]
  },
  rates: {
    heading: "Rate admin",
    body: [
      "The rate cards. This screen is not a reference — it is the billing menu: the lines here, in this order, are the dropdowns a technician gets on the ticket screen and the line order on the invoice the client sees.",
      "There is a house card, and each client can have their own. A client set to follow the default takes the house prices live, so a change to the house card changes them too. A client with their own card is on their own prices.",
      "Publish matters exactly once per card. After it has been published, edits go live as they save",
      "\"Restore removed lines\" puts back any standard line missing from a schedule at zero, ready to be priced. A job override prices one line differently for one job. Every price change is logged with who made it; the history is on each line.",
      "Prices are for Admins and Technicians: the screen opens for anyone given the Rate admin section, but the database hands other roles no figures and refuses their edits."
    ]
  },
  tracker: {
    heading: "Billing tracker",
    body: [
      "Every ticket across every job, paged on the server, with the four running totals worked out by the database rather than by adding up the rows on screen.",
      "Per row: resend the approval link, flag a ticket as chased, cancel an approval request so the ticket can be re-priced, and mark approved tickets as invoiced.",
      "\"Chase all unsigned\" re-sends the approval link to everything still waiting. It leaves alone anything sent or chased in the last three days or carrying an open client query, sends three at a time so the mail service is not overrun, waits out a rate limit instead of writing the ticket off, has a Stop, and names by number anything that failed.",
      "A client rep can send a question back from the approval page. That query shows on the row, and resending the link clears it.",
      "The money, the chase and the accounting export are for Admins and Technicians only. Other roles are handed no totals at all, which is exactly why the buttons are hidden — a chase from an account that cannot see prices would mail every client a $0.00 approval."
    ]
  },
  users: {
    heading: "Users & access",
    body: [
      "Accounts, their role, and which screens each one gets. New accounts are created here and will be sent a link to set their own password",
      "The tick boxes are a permission. A screen someone does not hold is a screen the database refuses them — so removing a tab to tidy up a menu also revokes access to that page altogether. Strip every tab and the account can read nothing at all.",
      "Job detail, the JHA builder, report upload and the billing ticket never appear in anybody's menu; they open from a job. Their permissions are still set here.",
      "An account with work on file is locked rather than deleted — the foreign keys are what keep their name on tickets and assessments. Unlock account lifts the ban and puts the role's usual screens back."
    ]
  },
  mail: {
    heading: "Admin",
    body: [
      "The settings the app needs to be fully working. Admin-only; a save applies at once.",
      "Email: the Resend key, the sending addresses, and the base address approval links are built from. Without a verified sending address, every send goes out under the mail service's test sender, which delivers only to the inbox the account was opened with. Test before trusting it.",
      "Invoices: the terms, GST number and remit-to block the field invoice prints. The number is the app's own, stamped when a ticket is invoiced.",
      "The error panel lists recent failures from the server-side functions, the log Home's attention strip counts.",
      "Archive builds a year or a date range as one zip. It reads every PDF and renders every invoice, so a busy year takes an hour. Clearing those jobs afterwards is gated three ways: the zip is checked against the build, the jobs are counted again just before the delete, and CLEAR has to be typed.",
      "Automatic backup writes every record and every PDF to a drive of the business's own, on a schedule, server-side. It restores two ways: chosen jobs, which deletes and overwrites nothing, or everything, which empties the database first behind four gates."
    ]
  }
};

// The screen's entry, or null. Null is a real answer — it is what hides the
// "?" rather than opening an empty dialog.
export function helpFor(screenKey) {
  return HELP[screenKey] || null;
}
