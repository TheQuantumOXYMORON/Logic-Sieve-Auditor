<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/12b5e44b-f324-482b-8e94-45afa84ebb57

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`
## 🚀 Overview
The Logic Sieve is a custom AI solution built to ensure deterministic integrity in testing. The app moves evaluation away from "mind-reading" the examiner and toward objective, fact-based logic.

## ✨ Key Features
This app identifies the following "Logic Traps":
*   **Subjective Superlatives:** Flagging terms like "most effective" when goals aren't defined.
*   **Undefined Variables:** Identifying missing context (e.g., "Which Sheet?").
*   **Hazardous Assumptions:** Spotting where a student must guess the environment.
*   **Deterministic Re-Drafting:** Rewriting flawed prompts into fact-based questions.

## 🛠 How it Works
The app utilizes a **Deterministic Engine** powered by **Gemini 1.5 Pro**. It was developed using **Vibe Coding** in **Google AI Studio** as part of the Google AI Professional Certificate.

## 📸 Screenshots
![Logic Sieve Dashboard](link-to-your-image.png)
