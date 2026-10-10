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

## How the photo flow works
1. **Upload**: the teacher picks a child and a date, then takes or chooses photos.
   The photos are shrunk to a maximum of 1600 px and saved under `<child>/<date>/` in the private bucket.
2. **Share**: the teacher picks a child and a date, selects photos, and taps **Share on WhatsApp**.
   The phone's share sheet opens, and the teacher taps WhatsApp and then the parent's chat. The photos are marked **Sent**.
   - On a desktop browser that can't share files, the photos download and WhatsApp opens directly in the parent's chat.
     The teacher then attaches the photos there.
3. **Children**: add each child with the parent's name and their WhatsApp number, including the country code.
