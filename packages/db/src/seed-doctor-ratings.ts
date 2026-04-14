import { PrismaClient, FeedbackCategory, SentimentLabel } from "@prisma/client";

const prisma = new PrismaClient();

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDateInPast(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - randomInt(0, days));
  d.setHours(randomInt(8, 20), randomInt(0, 59), 0, 0);
  return d;
}

const POSITIVE_COMMENTS = [
  "Dr. explained everything very patiently and answered all my questions. Felt reassured leaving the clinic.",
  "Excellent bedside manner. My mother was very anxious and doctor put her at ease immediately.",
  "Highly professional and thorough. Spent good time understanding history before prescribing.",
  "Timely consultation, on-point diagnosis, medicines worked as expected. Very happy.",
  "Compassionate and knowledgeable. Would definitely recommend to friends and family.",
  "Clear explanation of the treatment plan. Appreciated the follow-up call next day.",
  "Really good listener. Didn't rush through the consultation at all.",
  "Has a reassuring manner — my kid wasn't scared during the examination.",
  "Very prompt in responding to WhatsApp queries post-consultation.",
  "Transparent about costs and options. Didn't push unnecessary tests.",
  "Diagnosis was spot-on when two other doctors had missed it.",
  "Polite and respectful to both patient and family members.",
];

const NEUTRAL_COMMENTS = [
  "Consultation was okay. Had to wait 45 minutes past appointment time.",
  "Medicine prescribed helped but follow-up process was confusing.",
  "Good doctor but the clinic was a bit crowded and noisy.",
  "Competent but seemed in a hurry. Could spend a bit more time.",
  "Got the diagnosis right. Explanation could have been clearer.",
];

const NEGATIVE_COMMENTS = [
  "Felt rushed during consultation. Didn't get full answers to my concerns.",
  "Long wait despite booking an appointment. Doctor was good but the experience was stressful.",
  "Doctor seemed dismissive of my symptoms — had to insist on a test.",
  "Was prescribed antibiotics without much examination. Not satisfied.",
];

async function main() {
  console.log("\n=== Seeding Doctor Ratings & Feedback ===\n");

  const doctors = await prisma.doctor.findMany({ include: { user: true } });
  if (doctors.length === 0) {
    console.warn("  No doctors found. Skipping.");
    return;
  }

  const patients = await prisma.patient.findMany({ take: 50 });
  if (patients.length === 0) {
    console.warn("  No patients found. Skipping.");
    return;
  }

  let created = 0;
  let positive = 0;
  let neutral = 0;
  let negative = 0;

  for (const doc of doctors) {
    // Skip if doctor already has many feedback entries
    // (PatientFeedback is not linked to Doctor directly; we attribute via DOCTOR category & comment mention.)
    const count = randomInt(30, 50);
    for (let i = 0; i < count; i++) {
      const submittedAt = randomDateInPast(90);

      // Distribution: 60% 5-star, 25% 4-star, 10% 3-star, 5% 2-star
      const r = Math.random();
      let rating: number;
      let comment: string;
      let sentiment: SentimentLabel;
      let sentimentScore: number;
      if (r < 0.6) {
        rating = 5;
        comment = randomItem(POSITIVE_COMMENTS);
        sentiment = SentimentLabel.POSITIVE;
        sentimentScore = parseFloat((Math.random() * 0.4 + 0.6).toFixed(2));
        positive++;
      } else if (r < 0.85) {
        rating = 4;
        comment = randomItem(POSITIVE_COMMENTS);
        sentiment = SentimentLabel.POSITIVE;
        sentimentScore = parseFloat((Math.random() * 0.3 + 0.3).toFixed(2));
        positive++;
      } else if (r < 0.95) {
        rating = 3;
        comment = randomItem(NEUTRAL_COMMENTS);
        sentiment = SentimentLabel.NEUTRAL;
        sentimentScore = parseFloat((Math.random() * 0.3 - 0.1).toFixed(2));
        neutral++;
      } else {
        rating = 2;
        comment = randomItem(NEGATIVE_COMMENTS);
        sentiment = SentimentLabel.NEGATIVE;
        sentimentScore = parseFloat((Math.random() * 0.4 - 0.7).toFixed(2));
        negative++;
      }

      // Tag comment with doctor reference so we can attribute
      const finalComment = `[Dr. ${doc.user.name}] ${comment}`;

      const nps =
        rating === 5 ? randomInt(9, 10) : rating === 4 ? randomInt(7, 8) : rating === 3 ? randomInt(5, 6) : randomInt(0, 4);

      const patient = randomItem(patients);

      await prisma.patientFeedback.create({
        data: {
          patientId: patient.id,
          category: FeedbackCategory.DOCTOR,
          rating,
          nps,
          comment: finalComment,
          sentiment,
          sentimentScore,
          requestedVia: randomItem(["SMS", "EMAIL", "WALK_IN"]),
          submittedAt,
        },
      });
      created++;
    }
    console.log(`  ${doc.user.name}: ${count} feedback entries`);
  }

  console.log(`\n✔ Feedback entries created: ${created}`);
  console.log(`  Positive: ${positive}`);
  console.log(`  Neutral:  ${neutral}`);
  console.log(`  Negative: ${negative}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
