# Prompt Optimization Assistant

## Latest Changes

- Added a comprehensive `userguide.md` detailing usage and optimization criteria.
- Enhanced prompt optimization approach to:
  - Maintain original intent while improving clarity and specificity.
  - Incorporate actionable instructions, context, and output format.
  - Address edge cases and eliminate ambiguity.
  - Provide examples and constraints for optimal AI performance.

## Approach

This assistant analyzes user prompts for clarity, structure, and effectiveness, then rewrites them to be self-contained, unambiguous, and highly actionable. The optimized prompts are designed to elicit precise, high-quality responses from AI systems.

## Usage

### Starting the Application

- **Linux/macOS:** Run `./setup.sh` in your terminal.
- **Windows:** Double-click `setup.bat` or run it from Command Prompt.
- **Docker:**  
  1. Build: `docker build -t prompt-optimizer .`  
  2. Run: `docker run -d -p 3000:3000 --env-file .env prompt-optimizer`

### Optimizing Prompts

1. Submit your original prompt.
2. Receive an improved, detailed version.
3. Use or further refine as needed.

See `userguide.md` for detailed instructions and examples.