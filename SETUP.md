# Sanora setup

The landing page is `index.html`. The teacher app is `app/` (served at `/app`).
It is plain HTML with no build step, and Vercel serves it as is.

## 1. Create the Supabase project (5 min)
1. Go to https://supabase.com and create a free project named **sanora**.
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and click **Run**.
   This creates the tables and the private `photos` bucket, and it adds the two starting staff emails.
3. Open **Project Settings → API**. Copy the **Project URL** and the **anon public** key into `app/config.js`.

## 2. Turn on Google sign-in (10 min)
1. In Google Cloud Console (https://console.cloud.google.com), go to **APIs & Services → Credentials**.
   Choose **Create credentials → OAuth client ID** with type **Web application**.
   - Under **Authorized redirect URIs**, add `https://<your-project-ref>.supabase.co/auth/v1/callback`.
     The exact value is shown in Supabase under Authentication → Providers → Google.
   - If asked, configure the consent screen first, with External and app name Sanora.
2. In Supabase, open **Authentication → Providers → Google**. Turn it on and paste the Client ID and Client Secret.
3. In Supabase, open **Authentication → URL Configuration**:
   - Set **Site URL** to `https://sanorakids.vercel.app`.
   - Add `https://sanorakids.vercel.app/app/` to **Redirect URLs**.

## Who can get in
Anyone can press "Sign in with Google", but only emails in the `staff` table get past the sign-in screen.
The database itself also refuses all reads and writes from anyone else.

Run these in the SQL Editor to manage access:
```sql
insert into public.staff (email) values ('teacher@gmail.com');   -- give access
delete from public.staff where email = 'teacher@gmail.com';      -- remove access
select * from public.staff;                                      -- see who has access
```

## Admins (super users)
`smitha.jayathirtha@gmail.com` is an **admin**: everything a teacher can do, plus a **Staff** link (top right of the app)
to give or remove teacher access and to make other admins. Admins can't remove themselves.

## Center page
Smiles and Imagination has its own page at `/smiles-and-imagination/`, linked from the Sanora home page under **Our centers**.

## How the photo flow works
1. **Upload**: the teacher picks a child and a date, then takes or chooses photos.
   The photos are shrunk to a maximum of 1600 px and saved under `<child>/<date>/` in the private bucket.
2. **Photos** (the screen teachers see after signing in): every upload is organized by day (newest first), then by child.
   A filter shows one child's photos. To share, tap photos in one child's group, or tap "Select all", then tap **Share**.
   Pick WhatsApp in the share sheet, then the parent's chat. The photos are marked **Sent**.
   - On a desktop browser that can't share files, the photos download and WhatsApp opens directly in the parent's chat.
3. **Children**: add each child with the parent's name, WhatsApp number (including country code) and email.
   Tap **Edit** on a child to change these details or to add an email to an existing child.

## Daily note
In the **Daily note** tab, the teacher picks a child and fills in today's note: lunch (no / ate some / ate most / ate all),
snack, bowel movement (and how many times), nap (and how long), notes, and the teacher's sign (pre-filled from their Google name).
Tap an answer again to clear it. There is one note per child per day; saving again updates it.
The "Today's notes" list shows which children still need one. Parents see the note at the top of that day, above the photos.

## Check-in / check-out
Parents check their child in at drop-off and out at pick-up from the top of their screen.
The date defaults to today and the time to now, and both can be changed. The parent types their name, and a signature in handwriting style is generated from it.
The button switches to **Check out** once the child is checked in, and a check-out time earlier than the check-in time is rejected.
Teachers see every child's entries for any date in the **Check-in** tab: times, the parent's name and signature, and how many children are here now.

## Parent sign-in
Parents open https://sanorakids.vercel.app/app/ (or the **Sign in** button on the home page) and sign in with the email the teacher entered.
They only see photos of their own children, organized by day. They can tap a photo to view it full size and save it.
The database enforces this: a parent's account can't read any other child's rows or files.

- **Gmail parents**: "Sign in with Google". This works with no extra setup.
- **Any other email**: "Email me a sign-in link". Supabase's built-in email sender only delivers to your own team's addresses
  and is heavily rate-limited, so set up a real sender once:
  1. Create a free account at https://resend.com, add and verify a sending domain (or use their test domain to try it), and create an API key.
  2. In Supabase, go to **Authentication → Emails → SMTP Settings** and enable custom SMTP:
     host `smtp.resend.com`, port `465`, user `resend`, password = the API key, sender e.g. `Sanora <hello@yourdomain>`.

After pulling this version, re-run `supabase/schema.sql` in the SQL Editor (it's safe to re-run) to add the parent email column, the daily notes and attendance tables, the admin role and their access rules.
