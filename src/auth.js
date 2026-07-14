import { supabase } from './supabaseClient.js';

export async function signUp(email, password, fullName, companyName, captchaToken) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName, company_name: companyName }, captchaToken },
  });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export function onAuthStateChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session));
  return data.subscription;
}

// Exige a senha atual antes de trocar (evita que uma sessão aberta em outro
// lugar troque a senha sem o usuário confirmar quem ele é).
export async function changePassword(email, currentPassword, newPassword) {
  const { error: verifyError } = await supabase.auth.signInWithPassword({ email, password: currentPassword });
  if (verifyError) throw new Error('Senha atual incorreta.');

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

export async function updateEmail(newEmail) {
  const { error } = await supabase.auth.updateUser({ email: newEmail });
  if (error) throw error;
}
