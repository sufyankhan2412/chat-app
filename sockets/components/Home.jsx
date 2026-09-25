import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion, useScroll, useTransform, useInView } from "framer-motion";
import { useAuth } from "../context/Authcontext";

// Animated section wrapper
function AnimatedSection({ children, delay = 0 }) {
  const ref = React.useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 50 }}
      animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 50 }}
      transition={{ duration: 0.6, delay, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}

// Feature card component
function FeatureCard({ icon, title, description, delay = 0 }) {
  return (
    <motion.div
      className="feature-card"
      initial={{ opacity: 0, scale: 0.9 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={{ once: true, margin: "-50px" }}
      transition={{ duration: 0.5, delay }}
      whileHover={{ 
        scale: 1.05,
        boxShadow: "0 20px 40px rgba(18, 140, 126, 0.2)",
        transition: { duration: 0.2 }
      }}
    >
      <motion.div 
        className="feature-icon"
        whileHover={{ rotate: 360, scale: 1.2 }}
        transition={{ duration: 0.6, ease: "easeInOut" }}
      >
        {icon}
      </motion.div>
      <h3>{title}</h3>
      <p>{description}</p>
    </motion.div>
  );
}

// Animated stat counter
function StatCounter({ end, label, suffix = "" }) {
  const [count, setCount] = useState(0);
  const ref = React.useRef(null);
  const isInView = useInView(ref, { once: true });

  useEffect(() => {
    if (!isInView) return;
    
    const duration = 2000;
    const steps = 60;
    const increment = end / steps;
    const stepTime = duration / steps;
    
    let current = 0;
    const timer = setInterval(() => {
      current += increment;
      if (current >= end) {
        setCount(end);
        clearInterval(timer);
      } else {
        setCount(Math.floor(current));
      }
    }, stepTime);

    return () => clearInterval(timer);
  }, [isInView, end]);

  return (
    <motion.div 
      ref={ref}
      className="stat-item"
      initial={{ opacity: 0, scale: 0.5 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5 }}
    >
      <motion.div 
        className="stat-number"
        key={count}
      >
        {count}{suffix}
      </motion.div>
      <div className="stat-label">{label}</div>
    </motion.div>
  );
}

export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { scrollYProgress } = useScroll();
  const opacity = useTransform(scrollYProgress, [0, 0.2], [1, 0]);
  const scale = useTransform(scrollYProgress, [0, 0.2], [1, 0.95]);

  // If already logged in, redirect to chat
  useEffect(() => {
    if (user) {
      navigate("/chat");
    }
  }, [user, navigate]);

  return (
    <div className="home-page">
      {/* Hero Section */}
      <motion.section 
        className="hero-section"
        style={{ opacity, scale }}
      >
        <div className="hero-background">
          <motion.div 
            className="hero-circle hero-circle-1"
            animate={{
              scale: [1, 1.2, 1],
              opacity: [0.3, 0.5, 0.3],
            }}
            transition={{
              duration: 8,
              repeat: Infinity,
              ease: "easeInOut"
            }}
          />
          <motion.div 
            className="hero-circle hero-circle-2"
            animate={{
              scale: [1, 1.3, 1],
              opacity: [0.2, 0.4, 0.2],
            }}
            transition={{
              duration: 10,
              repeat: Infinity,
              ease: "easeInOut",
              delay: 1
            }}
          />
          <motion.div 
            className="hero-circle hero-circle-3"
            animate={{
              scale: [1, 1.15, 1],
              opacity: [0.25, 0.45, 0.25],
            }}
            transition={{
              duration: 9,
              repeat: Infinity,
              ease: "easeInOut",
              delay: 2
            }}
          />
        </div>

        <div className="hero-content">
          <motion.div
            className="hero-badge"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            ✨ Real-Time Communication Platform
          </motion.div>

          <motion.h1
            className="hero-title"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.3 }}
          >
            Connect, Communicate,
            <span className="hero-title-gradient"> Collaborate</span>
          </motion.h1>

          <motion.p
            className="hero-description"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.4 }}
          >
            Experience seamless messaging and crystal-clear video calls. 
            Built for teams, designed for everyone. Stay connected with the people who matter most.
          </motion.p>

          <motion.div
            className="hero-buttons"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.5 }}
          >
            <Link to="/signup">
              <motion.button
                className="btn-primary"
                whileHover={{ scale: 1.05, boxShadow: "0 12px 32px rgba(18, 140, 126, 0.3)" }}
                whileTap={{ scale: 0.98 }}
              >
                Get Started Free →
              </motion.button>
            </Link>
            <Link to="/login">
              <motion.button
                className="btn-secondary"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.98 }}
              >
                Sign In
              </motion.button>
            </Link>
          </motion.div>

          <motion.div
            className="hero-features-quick"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.6 }}
          >
            <span>✓ Instant Messaging</span>
            <span>✓ HD Video Calls</span>
            <span>✓ Voice Messages</span>
            <span>✓ File Sharing</span>
          </motion.div>
        </div>

        <motion.div
          className="hero-illustration"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, delay: 0.4 }}
        >
          <div className="floating-chat-bubble bubble-1">
            <motion.div
              animate={{ y: [0, -10, 0] }}
              transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
            >
              💬 Hey there!
            </motion.div>
          </div>
          <div className="floating-chat-bubble bubble-2">
            <motion.div
              animate={{ y: [0, -15, 0] }}
              transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut", delay: 0.5 }}
            >
              📞 Call me?
            </motion.div>
          </div>
          <div className="floating-chat-bubble bubble-3">
            <motion.div
              animate={{ y: [0, -12, 0] }}
              transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut", delay: 1 }}
            >
              🎥 Join meeting
            </motion.div>
          </div>
        </motion.div>
      </motion.section>

      {/* Stats Section */}
      <section className="stats-section">
        <div className="container">
          <div className="stats-grid">
            <StatCounter end={10000} label="Active Users" suffix="+" />
            <StatCounter end={50000} label="Messages Sent" suffix="+" />
            <StatCounter end={5000} label="Video Calls" suffix="+" />
            <StatCounter end={99} label="Uptime" suffix="%" />
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="features-section">
        <div className="container">
          <AnimatedSection>
            <div className="section-header">
              <h2>Powerful Features for Modern Communication</h2>
              <p>Everything you need to stay connected, all in one place</p>
            </div>
          </AnimatedSection>

          <div className="features-grid">
            <FeatureCard
              icon="💬"
              title="Instant Messaging"
              description="Send text, images, videos, and files instantly. Real-time delivery with read receipts."
              delay={0.1}
            />
            <FeatureCard
              icon="📞"
              title="Voice & Video Calls"
              description="Crystal-clear HD video calls and voice calls. Connect face-to-face from anywhere."
              delay={0.2}
            />
            <FeatureCard
              icon="👥"
              title="Group Conversations"
              description="Create group chats and conference calls. Collaborate with your entire team."
              delay={0.3}
            />
            <FeatureCard
              icon="🎤"
              title="Voice Messages"
              description="Record and send voice messages when typing isn't convenient. Quick and personal."
              delay={0.1}
            />
            <FeatureCard
              icon="📁"
              title="File Sharing"
              description="Share documents, photos, and videos securely. Support for all major file types."
              delay={0.2}
            />
            <FeatureCard
              icon="🔒"
              title="Privacy & Security"
              description="End-to-end encryption for all messages. Your conversations stay private and secure."
              delay={0.3}
            />
          </div>
        </div>
      </section>

      {/* How It Works Section */}
      <section className="how-it-works-section">
        <div className="container">
          <AnimatedSection>
            <div className="section-header">
              <h2>Get Started in Minutes</h2>
              <p>Simple, fast, and intuitive</p>
            </div>
          </AnimatedSection>

          <div className="steps-grid">
            <AnimatedSection delay={0.1}>
              <div className="step-card">
                <div className="step-number">1</div>
                <div className="step-content">
                  <h3>Create Your Account</h3>
                  <p>Sign up in seconds with just your email. No credit card required.</p>
                </div>
              </div>
            </AnimatedSection>

            <AnimatedSection delay={0.2}>
              <div className="step-card">
                <div className="step-number">2</div>
                <div className="step-content">
                  <h3>Add Your Contacts</h3>
                  <p>Search for friends and colleagues. Build your network instantly.</p>
                </div>
              </div>
            </AnimatedSection>

            <AnimatedSection delay={0.3}>
              <div className="step-card">
                <div className="step-number">3</div>
                <div className="step-content">
                  <h3>Start Connecting</h3>
                  <p>Send messages, make calls, and share moments. It's that simple!</p>
                </div>
              </div>
            </AnimatedSection>
          </div>
        </div>
      </section>

      {/* Services Section */}
      <section className="services-section">
        <div className="container">
          <AnimatedSection>
            <div className="section-header">
              <h2>Built for Every Use Case</h2>
              <p>Whether you're chatting with friends or collaborating with colleagues</p>
            </div>
          </AnimatedSection>

          <div className="services-grid">
            <AnimatedSection delay={0.1}>
              <div className="service-card">
                <div className="service-icon">👨‍💼</div>
                <h3>For Business</h3>
                <ul>
                  <li>Team collaboration</li>
                  <li>Virtual meetings</li>
                  <li>Project discussions</li>
                  <li>Client communications</li>
                </ul>
              </div>
            </AnimatedSection>

            <AnimatedSection delay={0.2}>
              <div className="service-card service-card-featured">
                <div className="featured-badge">Most Popular</div>
                <div className="service-icon">👥</div>
                <h3>For Teams</h3>
                <ul>
                  <li>Unlimited group chats</li>
                  <li>Conference calls</li>
                  <li>Screen sharing</li>
                  <li>Real-time collaboration</li>
                </ul>
              </div>
            </AnimatedSection>

            <AnimatedSection delay={0.3}>
              <div className="service-card">
                <div className="service-icon">❤️</div>
                <h3>For Personal</h3>
                <ul>
                  <li>Stay connected with family</li>
                  <li>Chat with friends</li>
                  <li>Share memories</li>
                  <li>Make video calls</li>
                </ul>
              </div>
            </AnimatedSection>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="cta-section">
        <div className="container">
          <motion.div
            className="cta-card"
            initial={{ opacity: 0, y: 50 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
          >
            <h2>Ready to Transform Your Communication?</h2>
            <p>Join thousands of users who are already enjoying seamless conversations</p>
            <Link to="/signup">
              <motion.button
                className="btn-cta"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.98 }}
              >
                Get Started Now - It's Free! 🚀
              </motion.button>
            </Link>
          </motion.div>
        </div>
      </section>

      {/* Footer */}
      <footer className="home-footer">
        <div className="container">
          <div className="footer-content">
            <div className="footer-brand">
              <h3>💬 ChatConnect</h3>
              <p>Real-time communication made simple</p>
            </div>
            <div className="footer-links">
              <div className="footer-column">
                <h4>Product</h4>
                <a href="#features">Features</a>
                <a href="#pricing">Pricing</a>
                <a href="#download">Download</a>
              </div>
              <div className="footer-column">
                <h4>Company</h4>
                <a href="#about">About Us</a>
                <a href="#careers">Careers</a>
                <a href="#contact">Contact</a>
              </div>
              <div className="footer-column">
                <h4>Support</h4>
                <a href="#help">Help Center</a>
                <a href="#privacy">Privacy</a>
                <a href="#terms">Terms</a>
              </div>
            </div>
          </div>
          <div className="footer-bottom">
            <p>&copy; 2024 ChatConnect. Built with ❤️ for better communication.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
