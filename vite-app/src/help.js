// What each screen is for, in the words you would use to a new hire.
//
// The three markdown files that explain this app live in the repository,
// where nobody in the field or the office will ever read them. This is the
// same knowledge where the question actually gets asked: the popup that
// meets an account the first time it opens a screen (helpTips.js), on the
// screen it is about.
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
      "Welcome to VagaboNDE Field-Ops",
      "On this screen you can see and open any of the created jobs, search through them, filter them and create new jobs using the +Job button on the top right of your screen. Press the hamburger menu button to see the other available tabs."
    ]
  },
  job: {
    heading: "Job detail",
    body: [
      "On this screen you can see the job details, open, create and send JHAs, and Tickets as well as upload and send reports. Start with your JHA, then create a new ticket. The ticket number will be displayed for you, input that new ticket number into your corresponding report. Once you're done for the day, PDF your spreadsheet, upload and send it to the contractor. Then open your ticket, fill out the billing and send to the client"
    ]
  },
  jha: {
    heading: "JHA builder",
    body: [
      "On this screen you can build your JHA. Your equipment should be automatically filled out from the system. If you recently picked up a new camera or dosimetry it may not have been updated yet and you might have to manually enter it in."
    ]
  },
  upload: {
    heading: "Report upload",
    body: [
      "Upload and send your report from this screen, your previously used numbers should be automatically pulled from the report and filled into the field. Just double check that it got them right in case another technician comes to work the job another day"
    ]
  },
  ticket: {
    heading: "Billing ticket",
    body: [
      "From here you build your ticket that will be sent to the client. Be sure to add your helper on to this as well as his hours are calculated from this screen. Once it has been sent to the client and has been signed for approval it can no longer be edited"
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
      "Templates, decay charts, study material and other important docs can be stored here."
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
      "Assigning equipment to a person is what makes the JHA builder pre-fill their JHAs. If a worker's dosimeter is wrong on an assessment, it is wrong here.",
      "The filters are by type, with Due soon and Overdue on the end; the search covers serial, type and the person it is assigned to."
    ]
  },
  timesheets: {
    heading: "Timesheets",
    body: [
      "The most important page: check your hours. There is no submit step — every line comes from a billing ticket, so a figure that is wrong is fixed on the ticket it came from, not here. An Admin approves each pay period, and the Approved timesheets tab is your record of it."
    ]
  },
  rates: {
    heading: "Rate admin",
    body: [
      "The rate cards. This screen is not a reference — it is the billing menu: the lines here, in this order, are the dropdowns a technician gets on the ticket screen and the line order on the invoice the client sees.",
      "There is a house card, and each client can have their own personalized rates. A client set to follow the default takes the house prices live, so a change to the house card changes them too. A client with their own card is on their own prices.",
      "Publish matters once per card. After it has been published, edits go live as they save",
      "\"Restore removed lines\" puts back any standard line missing from a schedule at zero, ready to be priced. A job override prices one line differently for one job. Every price change is logged with who made it",
      "Prices are for Admins and Technicians: the screen opens for anyone given the Rate admin section, but the database hands other roles no figures and refuses their edits."
    ]
  },
  tracker: {
    heading: "Billing tracker",
    body: [
      "Every ticket across every job, paged on the server, with the four running totals worked out by the database rather than by adding up the rows on screen.",
      "Per row: resend the approval link, flag a ticket as chased, and cancel an approval request so the ticket can be re-priced. Marking approved tickets invoiced is an Admin's, and so is \"Cancel and edit\".",
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
      "An account with work on file is locked rather than deleted — the foreign keys are what keep their name on tickets and assessments. Unlock account lifts the ban and puts the role's usual screens back. New accounts, roles, Remove account and Unlock account are an Admin's; the users tab on its own gives you the tick boxes and nothing more."
    ]
  },
  mail: {
    heading: "Admin",
    body: [
      "Set up email, invoice details and backups here. Only Admins can change these settings. Changes take effect when you save.",
      "Email: connect the email service, choose the addresses clients see, and enter the app's web address for approval links. Until your business's sending address is verified, test emails can only reach the inbox used to open the email-service account. Save your settings, then send a test email.",
      "Invoices: enter your payment terms, GST number and payment instructions. The app assigns an invoice number when you mark a ticket invoiced.",
      "Recent errors show tasks the app could not finish. These are also counted in Home's Needs attention section.",
      "Archive downloads a copy of jobs from a year or date range, including their documents and invoices, in one ZIP file. Large archives can take a while. Downloading does not delete anything. To remove those jobs afterwards, the app checks your downloaded copy, checks the jobs again, and asks you to type CLEAR.",
      "Automatic backup saves records and PDFs to your business's connected drive, even when the app is closed. You can bring back selected jobs without replacing existing work. Restoring everything replaces the app's current records and requires extra confirmation."
    ]
  }
};

// The screen's entry, or null. Null is a real answer — it is what keeps a
// screen with nothing to say quiet rather than raising an empty tip: App.jsx
// asks this before it raises one, and HelpTip asks again.
export function helpFor(screenKey) {
  return HELP[screenKey] || null;
}
